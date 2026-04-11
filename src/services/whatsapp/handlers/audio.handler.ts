import {
  ParsedWhatsAppMessage,
  fetchWhatsAppMedia,
  markAsRead,
  startTypingIndicator,
  stopTypingIndicator,
} from "../../whatsapp.service";
import {
  getOrCreateConversation,
  updateConversation,
  updateProfile,
  incrementProfileUsage,
} from "../memory.service";
import { logMessage, getConversationMessages } from "../messages.service";
import * as gemini from "../gemini.service";
import { Language, type ChatResponse } from "../gemini.service";
import { sendReplyAndLog, sendTextAndLog } from "../send.service";
import { askCity, cityConfirmation } from "../language.service";
import { checkAndEnforceQuota } from "../../subscription.service";
import { getExpertsByCity } from "../../expert.service";

async function buildHistoryContext(conversationId: string) {
  const msgs = await getConversationMessages(conversationId, 20);
  if (msgs.length === 0) return { summary: null, lastMessage: null };

  const lastBotMsg = [...msgs]
    .reverse()
    .find((m) => m.direction === "out" && m.body);
  const lastMessage = lastBotMsg?.body ?? null;

  const older = msgs.slice(0, -2);
  const summary =
    older.length > 0 ? await gemini.summarizeHistory(older) : null;

  return { summary, lastMessage };
}

export async function handleAudio(msg: ParsedWhatsAppMessage): Promise<void> {
  if (!msg.mediaId) return;

  markAsRead(msg.messageId).catch(() => {});

  const { conversation, profile } = await getOrCreateConversation(
    msg.from,
    msg.profileName,
  );

  // Voice-note users implicitly prefer voice replies.
  if (!profile.prefers_voice) {
    await updateProfile(profile.id, { prefers_voice: true });
  }

  // Quota check before expensive AI processing
  const quota = await checkAndEnforceQuota(
    msg.from,
    conversation.id,
    "voice",
    (conversation.language as Language) || "english",
  );
  if (!quota.allowed) {
    await sendTextAndLog(msg.from, quota.message!, conversation.id);
    return;
  }

  // Start persistent typing indicator for the entire audio pipeline
  startTypingIndicator(msg.from);
  try {
    // 1. Fetch audio + transcribe & detect language in one Gemini call.
    //    Gemini hears the raw audio so Pidgin words are preserved (Whisper normalises them away).
    const { buffer, mimeType } = await fetchWhatsAppMedia(msg.mediaId);

    // Track voice minutes: estimate duration from buffer size
    // OGG Opus (WhatsApp voice) ≈ 2 KB/s → buffer.length / 2000 = seconds
    const estimatedSeconds = Math.max(buffer.length / 2000, 1);
    const estimatedMinutes = Math.round((estimatedSeconds / 60) * 100) / 100;
    await incrementProfileUsage(
      profile.id,
      "usage_voice_minutes",
      estimatedMinutes,
    );

    const { transcript, language: lang } = await gemini.transcribeAudio(
      buffer,
      mimeType,
    );

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
        await sendReplyAndLog(
          msg.from,
          cityConfirmation(lang, city),
          lang,
          true,
          conversation.id,
        );
      } else {
        await sendReplyAndLog(
          msg.from,
          askCity(lang),
          lang,
          true,
          conversation.id,
        );
      }
      return;
    }

    // 4. Gemini chat — always reply with voice (isCurrentMessageVoice = true).
    const { summary, lastMessage } = await buildHistoryContext(conversation.id);
    const chatResponse = await gemini.chat(transcript, {
      language: lang,
      city: conversation.city,
      lastCrop: conversation.last_crop,
      cropTypes: profile.crop_types,
      summary,
      lastMessage,
    });

    // Handle special requests for audio — send insight link in text, or forward expert request
    if (chatResponse.special_request === "expert") {
      // For audio, acknowledge and offer expert help in text
      const experts = await getExpertsByCity(conversation.city || "");
      if (experts.length > 0) {
        const expertMsg =
          lang === "french"
            ? `Pour les experts, envoyez un message texte et je vous donnerai la liste.`
            : lang === "pidgin"
              ? `For expert help, send text message and I go give you the list.`
              : `To connect with experts, send a text message and I'll provide a list.`;
        await sendReplyAndLog(msg.from, expertMsg, lang, true, conversation.id);
      }
    } else if (chatResponse.special_request === "insight") {
      // Add insights CTA to voice reply
      const insightsCTA =
        lang === "french"
          ? `. Pour plus de détails, visitez farm-doctor.vercel.app/insights`
          : lang === "pidgin"
            ? `. For more details, check farm-doctor.vercel.app/insights`
            : `. For more details, visit farm-doctor.vercel.app/insights`;
      const replyWithCTA = chatResponse.reply + insightsCTA;
      await sendReplyAndLog(
        msg.from,
        replyWithCTA,
        lang,
        true,
        conversation.id,
      );
    } else {
      // Normal reply
      await sendReplyAndLog(
        msg.from,
        chatResponse.reply,
        lang,
        true,
        conversation.id,
      );
    }
  } finally {
    stopTypingIndicator(msg.from);
  }
}
