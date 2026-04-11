import {
  ParsedWhatsAppMessage,
  markAsRead,
  sendWhatsAppText,
  startTypingIndicator,
  stopTypingIndicator,
} from "../../whatsapp.service";
import { sendLanguageMenu } from "../../whatsapp.service";
import { getOrCreateConversation, updateConversation } from "../memory.service";
import { logMessage, getConversationMessages } from "../messages.service";
import {
  detectLanguageMenuChoice,
  welcomeMessage,
  askCity,
  cityConfirmation,
} from "../language.service";
import * as gemini from "../gemini.service";
import { Language } from "../gemini.service";
import { sendTextAndLog, sendReplyAndLog } from "../send.service";
import { checkAndEnforceQuota } from "../../subscription.service";
import { maybeSuggestExpert } from "../expert-suggest.service";

async function buildHistoryContext(conversationId: string) {
  const msgs = await getConversationMessages(conversationId, 20);
  if (msgs.length === 0) return { summary: null, lastMessage: null };

  // Last bot reply
  const lastBotMsg = [...msgs]
    .reverse()
    .find((m) => m.direction === "out" && m.body);
  const lastMessage = lastBotMsg?.body ?? null;

  // Summarise all but the last 2 messages (current exchange)
  const older = msgs.slice(0, -2);
  const summary =
    older.length > 0 ? await gemini.summarizeHistory(older) : null;

  return { summary, lastMessage };
}

export async function handleText(msg: ParsedWhatsAppMessage): Promise<void> {
  const text = (msg.text ?? "").trim();
  if (!text) return;

  markAsRead(msg.messageId).catch(() => {});

  const { conversation, profile, isNew } = await getOrCreateConversation(
    msg.from,
    msg.profileName,
  );

  // Log inbound message immediately so the dashboard shows it.
  await logMessage({
    conversation_id: conversation.id,
    direction: "in",
    type: "text",
    body: text,
    wa_message_id: msg.messageId,
  });

  // ── Step 1: language selection ──────
  if (isNew || !conversation.language) {
    const choice = detectLanguageMenuChoice(text);
    if (!choice) {
      // Also try sending the interactive list menu as an enhancement
      await sendLanguageMenu(msg.from);
      return;
    }
    await updateConversation(conversation.id, { language: choice });
    await sendTextAndLog(msg.from, askCity(choice), conversation.id);
    return;
  }

  const lang = conversation.language as Language;

  // ── Step 2: city onboarding ─────────
  if (!conversation.city) {
    const city = text.split("\n")[0].slice(0, 64).trim();
    if (!city) {
      await sendTextAndLog(msg.from, askCity(lang), conversation.id);
      return;
    }
    await updateConversation(conversation.id, { city });
    await sendTextAndLog(
      msg.from,
      cityConfirmation(lang, city),
      conversation.id,
    );
    return;
  }

  // ── Step 3: quota check before AI processing ──
  const quota = await checkAndEnforceQuota(msg.from, conversation.id, "text");
  if (!quota.allowed) {
    await sendTextAndLog(msg.from, quota.message!, conversation.id);
    return;
  }

  // ── Step 4: normal chat reasoning ───
  startTypingIndicator(msg.from);
  try {
    const { summary, lastMessage } = await buildHistoryContext(conversation.id);
    const reply = await gemini.chat(text, {
      language: lang,
      city: conversation.city,
      lastCrop: conversation.last_crop,
      cropTypes: profile.crop_types,
      summary,
      lastMessage,
    });

    await sendReplyAndLog(msg.from, reply, lang, false, conversation.id);

    // ── Step 5: maybe suggest expert (non-blocking) ──
    await maybeSuggestExpert(
      msg.from,
      conversation.id,
      conversation.city,
      lang,
    );
  } finally {
    stopTypingIndicator(msg.from);
  }
}
