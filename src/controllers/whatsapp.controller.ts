import { FastifyRequest, FastifyReply } from "fastify";
import {
  parseWhatsAppPayload,
  verifyWebhookChallenge,
  ParsedWhatsAppMessage,
  sendWhatsAppText,
  sendLanguageMenu,
} from "../services/whatsapp.service";
import { logger } from "../utils/logger";
import { cancelPending, beginProcessing } from "../services/whatsapp/retry.service";
import { handleText } from "../services/whatsapp/handlers/text.handler";
import { handleImage } from "../services/whatsapp/handlers/image.handler";
import { handleAudio } from "../services/whatsapp/handlers/audio.handler";
import {
  getOrCreateConversation,
  updateConversation,
} from "../services/whatsapp/memory.service";
import { logMessage } from "../services/whatsapp/messages.service";
import { askCity } from "../services/whatsapp/language.service";
import { Language } from "../services/whatsapp/gemini.service";
import { handleExpertResponse } from "../services/whatsapp/expert-suggest.service";

// ─── Deduplication ──────────────────
const DEDUP_TTL = 5 * 60 * 1000;
const processed = new Map<string, number>();
function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  if (processed.size > 500) {
    for (const [id, ts] of processed) {
      if (now - ts > DEDUP_TTL) processed.delete(id);
    }
  }
  if (processed.has(messageId)) return true;
  processed.set(messageId, now);
  return false;
}

// ─── Language from interactive list reply ─
function parseLanguageFromInteractive(interactiveId?: string): Language | null {
  switch (interactiveId) {
    case "lang_en": return "english";
    case "lang_fr": return "french";
    case "lang_pidgin": return "pidgin";
    default: return null;
  }
}

// ─── Process single WhatsApp message ─
// This mirrors the exact flow from the admin-dashboard webhook:
//   1. Deduplication + cancellation of in-flight retries
//   2. Interactive list language selection (enhanced onboarding)
//   3. Delegates to text/image/audio handlers (which handle text-based
//      language selection, city onboarding, Gemini chat, Gemini Vision
//      diagnosis, Gemini audio transcription, voice replies, crop reports, etc.)
async function routeWhatsAppMessage(msg: ParsedWhatsAppMessage) {
  try {
    // ── Handle interactive list reply (language selection menu) ──
    // The interactive list is an enhancement over the text-based menu.
    // If the user taps a language from the list, we handle it here
    // before the normal text/image/audio handlers.
    if (msg.type === "interactive" && msg.interactiveId) {
      // ── Expert suggestion response ──
      if (msg.interactiveId === "expert_yes" || msg.interactiveId === "expert_no") {
        const { conversation } = await getOrCreateConversation(msg.from, msg.profileName);
        const lang = (conversation.language || "english") as Language;
        await handleExpertResponse(
          msg.from,
          conversation.id,
          conversation.city,
          lang,
          msg.interactiveId === "expert_yes",
        );
        return;
      }

      // ── Language selection ──
      const lang = parseLanguageFromInteractive(msg.interactiveId);
      if (lang) {
        const { conversation } = await getOrCreateConversation(msg.from, msg.profileName);
        await updateConversation(conversation.id, { language: lang });
        await sendWhatsAppText(msg.from, askCity(lang));
        await logMessage({
          conversation_id: conversation.id,
          direction: "out",
          type: "text",
          body: askCity(lang),
        });
        return;
      }
    }

    // ── Delegate to the exact dashboard handler logic ──
    switch (msg.type) {
      case "text":
        await handleText(msg);
        break;
      case "image":
        await handleImage(msg);
        break;
      case "audio":
        await handleAudio(msg);
        break;
      case "interactive":
        // Non-language interactive replies — treat as text if they have a title
        if (msg.interactiveTitle) {
          await handleText({ ...msg, type: "text", text: msg.interactiveTitle });
        }
        break;
      case "document":
      case "unsupported":
      default:
        // Not yet supported — ignore silently.
        break;
    }
  } catch (err) {
    logger.error(err, "Error in WhatsApp message routing");
    try {
      await sendWhatsAppText(msg.from, "Sorry, something went wrong. Please try again.");
    } catch {}
  }
}

// ─── Fastify handlers ───────────────
export const handleWhatsAppVerify = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const mode = (request.query as any)["hub.mode"];
  const token = (request.query as any)["hub.verify_token"];
  const challenge = (request.query as any)["hub.challenge"];

  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    request.log.info("WhatsApp webhook verified successfully");

    return reply
      .code(200)
      .header("Content-Type", "text/plain")
      .send(challenge);
  }

  request.log.error(
  `Webhook verification failed: mode=${mode}, token=${token}`
);;

  return reply.code(403).send("Forbidden");
};

export const handleWhatsAppWebhook = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const messages = parseWhatsAppPayload(request.body);

    for (const msg of messages) {
      if (isDuplicate(msg.messageId)) continue;
      // Kill any in-flight retries from previous messages for this user.
      cancelPending(msg.from);
      beginProcessing(msg.from);
      routeWhatsAppMessage(msg).catch((err) => {
        logger.error(err, "WhatsApp async handler error");
      });
    }

    // Always return 200 quickly so Meta does not retry and mark the webhook unhealthy.
    return reply.status(200).send("ok");
  } catch (error) {
    logger.error(error, "Error parsing WhatsApp webhook");
    return reply.status(200).send("ok");
  }
};
