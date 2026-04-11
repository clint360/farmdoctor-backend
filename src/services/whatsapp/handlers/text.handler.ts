import { ParsedWhatsAppMessage, markAsRead, startTypingIndicator, stopTypingIndicator } from "../../whatsapp.service";
import {
  getOrCreateConversation,
  updateConversation,
} from "../memory.service";
import { logMessage, getConversationMessages } from "../messages.service";
import {
  detectLanguageMenuChoice,
  detectLanguageFromText,
  askCity,
  cityConfirmation,
} from "../language.service";
import * as gemini from "../gemini.service";
import { Language, type ChatResponse } from "../gemini.service";
import { sendTextAndLog, sendReplyAndLog } from "../send.service";
import { checkAndEnforceQuota } from "../../subscription.service";
import { maybeSuggestExpert } from "../expert-suggest.service";
import { getExpertsByCity } from "../../expert.service";

async function buildHistoryContext(conversationId: string) {
  const msgs = await getConversationMessages(conversationId, 20);
  if (msgs.length === 0) return { summary: null, lastMessage: null };

  // Last bot reply
  const lastBotMsg = [...msgs].reverse().find((m) => m.direction === "out" && m.body);
  const lastMessage = lastBotMsg?.body ?? null;

  // Summarise all but the last 2 messages (current exchange)
  const older = msgs.slice(0, -2);
  const summary = older.length > 0 ? await gemini.summarizeHistory(older) : null;

  return { summary, lastMessage };
}

function buildExpertListMessage(
  lang: Language,
  city: string,
  experts: Array<{ full_name: string; phone: string }>
): string {
  const header =
    lang === "french"
      ? `🌾 *Experts Agricoles près de ${city}:*`
      : lang === "pidgin"
        ? `🌾 *Farm Experts for ${city}:*`
        : `🌾 *Agricultural Experts near ${city}:*`;

  const list = experts
    .slice(0, 5)
    .map((e, i) => `${i + 1}. *${e.full_name}*\n   📞 ${e.phone}`)
    .join("\n\n");

  const footer =
    lang === "french"
      ? "Contactez-les directement pour une aide professionnelle !"
      : lang === "pidgin"
        ? "Call dem direct for help!"
        : "Contact them directly for professional farm help!";

  return `${header}\n\n${list}\n\n${footer}`;
}

export async function handleText(msg: ParsedWhatsAppMessage): Promise<void> {
  const text = (msg.text ?? "").trim();
  if (!text) return;

  markAsRead(msg.messageId).catch(() => {});

  const { conversation, profile, isNew } = await getOrCreateConversation(
    msg.from,
    msg.profileName
  );

  // Log inbound message immediately so the dashboard shows it.
  await logMessage({
    conversation_id: conversation.id,
    direction: "in",
    type: "text",
    body: text,
    wa_message_id: msg.messageId,
  });

  // ── Step 1: language (silent auto-detect, never ask) ──────
  if (!conversation.language) {
    let choice = detectLanguageMenuChoice(text) || detectLanguageFromText(text) || "english";
    await updateConversation(conversation.id, { language: choice });
    conversation.language = choice;
  }

  // Keep language in sync if user switches mid-conversation
  const detectedLang = detectLanguageFromText(text);
  let lang = conversation.language as Language;
  if (detectedLang && detectedLang !== lang) {
    lang = detectedLang;
    await updateConversation(conversation.id, { language: lang });
  }

  // ── Step 2: city (only ask once, needed for DB) ─────────
  if (!conversation.city) {
    if (isNew) {
      // First message ever — ask their location
      await sendTextAndLog(msg.from, askCity(lang), conversation.id);
      return;
    }
    // Second message — treat it as the city answer
    const city = text.split("\n")[0].slice(0, 64).trim();
    if (city) {
      await updateConversation(conversation.id, { city });
      await sendTextAndLog(msg.from, cityConfirmation(lang, city), conversation.id);
      return;
    }
  }

  // ── Step 3: quota check before AI processing ──
  const quota = await checkAndEnforceQuota(msg.from, conversation.id, "text", lang);
  if (!quota.allowed) {
    await sendTextAndLog(msg.from, quota.message!, conversation.id);
    return;
  }

  // ── Step 4: normal chat reasoning ───
  startTypingIndicator(msg.from);
  try {
    const { summary, lastMessage } = await buildHistoryContext(conversation.id);
    const chatResponse = await gemini.chat(text, {
      language: lang,
      city: conversation.city,
      lastCrop: conversation.last_crop,
      cropTypes: profile.crop_types,
      summary,
      lastMessage,
    });

    // Handle special requests
    if (chatResponse.special_request === "expert") {
      // Route to expert listing
      const experts = await getExpertsByCity(conversation.city || "");
      
      if (experts.length > 0) {
        const expertListText = buildExpertListMessage(lang, conversation.city!, experts);
        await sendTextAndLog(msg.from, expertListText, conversation.id);
      } else {
        const noExpertsMsg =
          lang === "french"
            ? `Désolé, aucun expert disponible près de votre champ pour le moment. Nous travaillons à en ajouter !`
            : lang === "pidgin"
              ? `Sorry, no expert dey for farm area now. We dey work to add some!`
              : `Sorry, no experts available near your farm right now. We're working on adding more!`;
        await sendTextAndLog(msg.from, noExpertsMsg, conversation.id);
      }
    } else if (chatResponse.special_request === "insight") {
      // Add insights tool CTA to natural reply
      const insightsCTA =
        lang === "french"
          ? `\n\n*Pour plus de détails sur les cultures et votre région, visitez:* https://farmer-hack.vercel.app/insights`
          : lang === "pidgin"
            ? `\n\n*For more details about crops in your area, check:* https://farmer-hack.vercel.app/insights`
            : `\n\nFor more detailed, location-specific crop information, check: https://farmer-hack.vercel.app/insights`;
      
      const replyWithCTA = chatResponse.reply + insightsCTA;
      await sendReplyAndLog(msg.from, replyWithCTA, lang, false, conversation.id);
    } else {
      // Normal reply
      await sendReplyAndLog(msg.from, chatResponse.reply, lang, false, conversation.id);
    }

    // ── Step 5: maybe suggest expert (non-blocking) ──
    await maybeSuggestExpert(msg.from, conversation.id, conversation.city, lang);
  } finally {
    stopTypingIndicator(msg.from);
  }
}
