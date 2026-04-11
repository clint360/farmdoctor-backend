import { FastifyRequest, FastifyReply } from "fastify";
import {
  TelegramUpdate,
  sendChatAction,
  sendMessage,
  sendVoice,
  getTelegramFileUrl,
  answerCallbackQuery,
} from "../services/telegram.service";
import { logger } from "../utils/logger";
import {
  getOrCreateConversationForPlatform,
  updateConversation,
  updateProfile,
} from "../services/whatsapp/memory.service";
import { logMessage, getConversationMessages } from "../services/whatsapp/messages.service";
import * as gemini from "../services/whatsapp/gemini.service";
import { Language } from "../services/whatsapp/gemini.service";
import { detectLanguageFromText } from "../services/whatsapp/language.service";

// ─── Helpers ──────────────────────────────────────────




const downloadFile = async (url: string): Promise<Buffer> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

async function buildHistoryContext(conversationId: string) {
  const msgs = await getConversationMessages(conversationId, 20);
  if (msgs.length === 0) return { summary: null, lastMessage: null };

  const lastBotMsg = [...msgs].reverse().find((m) => m.direction === "out" && m.body);
  const lastMessage = lastBotMsg?.body ?? null;

  const older = msgs.slice(0, -2);
  const summary = older.length > 0 ? await gemini.summarizeHistory(older) : null;

  return { summary, lastMessage };
}

async function withTyping(
  chatId: number,
  action: "typing" | "record_voice",
  handler: () => Promise<void>,
): Promise<void> {
  let interval: NodeJS.Timeout | null = null;
  try {
    await sendChatAction(chatId, action);
    interval = setInterval(() => void sendChatAction(chatId, action), 4000);
    await handler();
  } finally {
    if (interval) clearInterval(interval);
  }
}


// ─── Build display name from Telegram user ────────────
function buildDisplayName(from?: { first_name?: string; last_name?: string; username?: string }): string | undefined {
  if (!from) return undefined;
  const full = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return full || from.username || undefined;
}

// ─── Text ─────────────────────────────────────────────

async function handleText(chatId: number, text: string, name?: string): Promise<void> {
  const phone = `tg_${chatId}`;
  const { conversation, profile } = await getOrCreateConversationForPlatform(
    phone,
    "telegram",
    name,
  );

  await logMessage({ conversation_id: conversation.id, direction: "in", type: "text", body: text });

  // Keep name in sync
  if (name && name !== conversation.name) {
    await updateConversation(conversation.id, { name });
  }

  // Auto-detect language silently, never ask
  if (!conversation.language) {
    const detected = detectLanguageFromText(text) ?? "english";
    await updateConversation(conversation.id, { language: detected });
    conversation.language = detected;
  }

  // Keep in sync if user switches language mid-conversation
  const detectedLang = detectLanguageFromText(text);
  let lang = conversation.language as Language;
  if (detectedLang && detectedLang !== lang) {
    lang = detectedLang;
    await updateConversation(conversation.id, { language: lang });
  }

  await withTyping(chatId, "typing", async () => {
    const { summary, lastMessage } = await buildHistoryContext(conversation.id);
    const { reply } = await gemini.chat(text, {
      language: lang,
      city: conversation.city,
      lastCrop: conversation.last_crop,
      cropTypes: profile.crop_types,
      summary,
      lastMessage,
    });

    await sendMessage(chatId, (reply));
    await logMessage({ conversation_id: conversation.id, direction: "out", type: "text", body: reply });
  });
}

// ─── Image ────────────────────────────────────────────

async function handleImage(chatId: number, fileId: string, name?: string): Promise<void> {
  const phone = `tg_${chatId}`;
  const { conversation, profile } = await getOrCreateConversationForPlatform(phone, "telegram", name);

  if (!conversation.language) {
    await updateConversation(conversation.id, { language: "english" });
    conversation.language = "english";
  }
  const lang = conversation.language as Language;

  const url = await getTelegramFileUrl(fileId);
  if (!url) {
    await sendMessage(chatId, ("Sorry, I couldn't download your image. Please try again."));
    return;
  }

  await withTyping(chatId, "typing", async () => {
    const buffer = await downloadFile(url);

    await logMessage({ conversation_id: conversation.id, direction: "in", type: "image", media_url: url });

    const diagnosis = await gemini.diagnoseImage(buffer, "image/jpeg", {
      language: lang,
      city: conversation.city,
      cropTypes: profile.crop_types,
      lastCrop: conversation.last_crop,
    });

    if (diagnosis.cropType) {
      await updateConversation(conversation.id, { last_crop: diagnosis.cropType });
    }

    const reply = await gemini.explainDiagnosisToFarmer(diagnosis, {
      language: lang,
      city: conversation.city,
      cropTypes: profile.crop_types,
    });

    await sendMessage(chatId, (reply));
    await logMessage({ conversation_id: conversation.id, direction: "out", type: "text", body: reply });
  });
}

// ─── Voice ────────────────────────────────────────────

async function handleVoice(chatId: number, fileId: string, name?: string): Promise<void> {
  const phone = `tg_${chatId}`;
  const { conversation, profile } = await getOrCreateConversationForPlatform(phone, "telegram", name);

  if (!profile.prefers_voice) {
    await updateProfile(profile.id, { prefers_voice: true });
  }

  const url = await getTelegramFileUrl(fileId);
  if (!url) {
    await sendMessage(chatId, ("Sorry, I couldn't download your voice note. Please try again."));
    return;
  }

  await withTyping(chatId, "record_voice", async () => {
    const buffer = await downloadFile(url);
    const { transcript, language: lang } = await gemini.transcribeAudio(buffer, "audio/ogg");

    await logMessage({ conversation_id: conversation.id, direction: "in", type: "audio", body: transcript });

    if (lang !== conversation.language) {
      await updateConversation(conversation.id, { language: lang });
    }

    const { summary, lastMessage } = await buildHistoryContext(conversation.id);
    const { reply } = await gemini.chat(transcript, {
      language: lang,
      city: conversation.city,
      lastCrop: conversation.last_crop,
      cropTypes: profile.crop_types,
      summary,
      lastMessage,
    });

    // Pidgin: translate to Cameroon Pidgin text → YarnGPT audio
    // English/French: OpenAI TTS directly
    // Falls back to text if audio fails
    try {
      let audioBuffer: Buffer;
      if (lang === "pidgin") {
        const pidginText = await gemini.translateToPidgin(reply);
        const { synthesizePidgin } = await import("../services/whatsapp/voice.service");
        const audio = await synthesizePidgin(pidginText);
        audioBuffer = audio.buffer;
      } else {
        const { ttsService } = await import("../services/ai/tts.service");
        const ttsLang = lang === "french" ? "fr" : "en";
        audioBuffer = await ttsService.speak(reply, ttsLang);
      }
      await sendVoice(chatId, audioBuffer);
    } catch {
      await sendMessage(chatId, (reply));
    }

    await logMessage({ conversation_id: conversation.id, direction: "out", type: "text", body: reply });
  });
}

// ─── Router ───────────────────────────────────────────

const routeFarmerWebhook = async (update: TelegramUpdate): Promise<void> => {
  if (update.callback_query) {
    const { id, message, data = "", from } = update.callback_query;
    const chatId = message?.chat.id;
    await answerCallbackQuery(id);
    if (!chatId) return;

    if (data.startsWith("lang_")) {
      const lang: Language =
        data === "lang_fr" ? "french" : data === "lang_pidgin" ? "pidgin" : "english";
      const phone = `tg_${chatId}`;
      const { conversation } = await getOrCreateConversationForPlatform(phone, "telegram", from?.first_name);
      await updateConversation(conversation.id, { language: lang });
      const confirm =
        lang === "french"
          ? "D'accord, je vais repondre en francais."
          : lang === "pidgin"
            ? "No wahala. I go tok pidgin with you."
            : "Alright, I will reply in English.";
      await sendMessage(chatId, (confirm));
    }
    return;
  }

  if (!update.message) return;

  const { chat, text, photo, voice, from: msgFrom } = update.message;
  const chatId = chat.id;
  const displayName = buildDisplayName(msgFrom);

  try {
    if (text === "/start" || text === "/settings") {
      const phone = `tg_${chatId}`;
      const { conversation } = await getOrCreateConversationForPlatform(phone, "telegram", displayName);
      await updateConversation(conversation.id, { language: null, city: null });
      await sendMessage(
        chatId,
        ("Welcome to Farm Doctor! 🌱 I'm your AI farming assistant.\n\nJust tell me about your crop problem, send a photo, or send a voice note — in any language."),
      );
      return;
    }

    if (text) { await handleText(chatId, text, displayName); return; }
    if (photo) { await handleImage(chatId, photo[photo.length - 1].file_id, displayName); return; }
    if (voice) { await handleVoice(chatId, voice.file_id, displayName); return; }

    await sendMessage(chatId, ("I understand text messages, crop photos, and voice notes. What's going on with your farm?"));
  } catch (err) {
    logger.error(err, "Error in Telegram webhook handler");
    await sendMessage(chatId, ("Sorry, something went wrong. Please try again.")).catch(() => {});
  }
};

export const handleTelegramWebhook = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  try {
    const update = request.body as TelegramUpdate;
    routeFarmerWebhook(update).catch((err) => {
      logger.error(err, "Failed async Telegram webhook routing");
    });
    return reply.status(200).send({ success: true });
  } catch (error) {
    logger.error(error, "Error parsing Telegram webhook body");
    return reply.status(500).send({ success: false });
  }
};
