import { sendWhatsAppText } from "../whatsapp.service";
import { sendReply } from "./voice.service";
import { logMessage } from "./messages.service";
import { Language } from "./gemini.service";

// ─── Send wrappers that also persist messages to the dashboard log ───
// Handlers should use these instead of raw WhatsApp send functions
// so every outbound reply shows up in the admin conversation history.

export async function sendTextAndLog(
  to: string,
  body: string,
  conversationId: string
): Promise<void> {
  await sendWhatsAppText(to, body);
  await logMessage({
    conversation_id: conversationId,
    direction: "out",
    type: "text",
    body,
  });
}

export async function sendReplyAndLog(
  to: string,
  text: string,
  language: Language,
  isCurrentMessageVoice: boolean,
  conversationId: string
): Promise<void> {
  await sendReply(to, text, language, isCurrentMessageVoice);
  // Always log the textual content. Whether delivered as voice or text,
  // the dashboard displays the words the bot actually said.
  await logMessage({
    conversation_id: conversationId,
    direction: "out",
    type: "text",
    body: text,
  });
}
