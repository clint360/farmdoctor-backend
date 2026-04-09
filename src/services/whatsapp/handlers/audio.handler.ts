import { ParsedWhatsAppMessage, fetchWhatsAppMedia, markAsRead } from "../../whatsapp.service";
import {
  getOrCreateConversation,
  updateConversation,
  updateProfile,
} from "../memory.service";
import { logMessage, getConversationMessages } from "../messages.service";
import * as gemini from "../gemini.service";
import { Language } from "../gemini.service";
import { sendReplyAndLog } from "../send.service";
import { askCity, cityConfirmation } from "../language.service";

async function buildHistoryContext(conversationId: string) {
  const msgs = await getConversationMessages(conversationId, 20);
  if (msgs.length === 0) return { summary: null, lastMessage: null };

  const lastBotMsg = [...msgs].reverse().find((m) => m.direction === "out" && m.body);
  const lastMessage = lastBotMsg?.body ?? null;

  const older = msgs.slice(0, -2);
  const summary = older.length > 0 ? await gemini.summarizeHistory(older) : null;

  return { summary, lastMessage };
}

export async function handleAudio(msg: ParsedWhatsAppMessage): Promise<void> {
  if (!msg.mediaId) return;

  markAsRead(msg.messageId).catch(() => {});

  const { conversation, profile } = await getOrCreateConversation(
    msg.from,
    msg.profileName
  );

  // Voice-note users implicitly prefer voice replies.
  if (!profile.prefers_voice) {
    await updateProfile(profile.id, { prefers_voice: true });
  }

  // 1. Fetch audio + transcribe & detect language in one Gemini call.
  //    Gemini hears the raw audio so Pidgin words are preserved (Whisper normalises them away).
  const { buffer, mimeType } = await fetchWhatsAppMedia(msg.mediaId);
  const { transcript, language: lang } = await gemini.transcribeAudio(buffer, mimeType);

  await logMessage({
    conversation_id: conversation.id,
    direction: "in",
    type: "audio",
    body: transcript,
    wa_message_id: msg.messageId,
  });

  // 2. Update stored language if it changed.
  if (lang !== conversation.language) {
    await updateConversation(conversation.id, { language: lang });
  }

  // 3. City onboarding — reply with voice even during onboarding.
  if (!conversation.city) {
    const city = transcript.split("\n")[0].slice(0, 64).trim();
    if (city) {
      await updateConversation(conversation.id, { city });
      await sendReplyAndLog(msg.from, cityConfirmation(lang, city), lang, true, conversation.id);
    } else {
      await sendReplyAndLog(msg.from, askCity(lang), lang, true, conversation.id);
    }
    return;
  }

  // 4. Gemini chat — always reply with voice (isCurrentMessageVoice = true).
  const { summary, lastMessage } = await buildHistoryContext(conversation.id);
  const reply = await gemini.chat(transcript, {
    language: lang,
    city: conversation.city,
    lastCrop: conversation.last_crop,
    cropTypes: profile.crop_types,
    summary,
    lastMessage,
  });

  await sendReplyAndLog(msg.from, reply, lang, true, conversation.id);
}
