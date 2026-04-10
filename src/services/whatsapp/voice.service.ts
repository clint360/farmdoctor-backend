import OpenAI from "openai";
import { Language } from "./gemini.service";
import * as gemini from "./gemini.service";
import {
  sendWhatsAppText,
  uploadWhatsAppMedia,
  sendWhatsAppAudio,
} from "../whatsapp.service";
import { withRetry } from "./retry.service";
import { logger } from "../../utils/logger";

// ─── Config ─────────────────────────
const getOpenAiKey = () => process.env.OPENAI_API_KEY || "";
const getOpenAiTtsModel = () => process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const getOpenAiTtsVoice = () => process.env.OPENAI_TTS_VOICE || "alloy";
const getYarnGptKey = () => process.env.YARNGPT_API_KEY || "";
const getYarnGptUrl = () => process.env.YARNGPT_API_URL || "https://yarngpt.ai/api/v1/tts";
const getYarnGptVoice = () => process.env.YARNGPT_VOICE || "Idera";
const isVoiceEnabled = () => {
  const v = process.env.ENABLE_VOICE_REPLIES;
  if (v === undefined) return true;
  return v === "true" || v === "1";
};

let _openaiClient: OpenAI | null = null;
function openaiClient(): OpenAI {
  if (!_openaiClient) _openaiClient = new OpenAI({ apiKey: getOpenAiKey() });
  return _openaiClient;
}

// ─── OpenAI TTS (English + French) ──
async function synthesizeOpenAI(text: string): Promise<{ buffer: Buffer; mimeType: string }> {
  return withRetry(async () => {
    const res = await openaiClient().audio.speech.create({
      model: getOpenAiTtsModel(),
      voice: getOpenAiTtsVoice() as unknown as "alloy",
      input: text,
      response_format: "opus",
    });
    const arr = await res.arrayBuffer();
    return { buffer: Buffer.from(arr), mimeType: "audio/ogg" };
  }, { label: "openai.synthesize" });
}

// ─── YarnGPT TTS (Pidgin) ──────────
async function synthesizePidgin(text: string): Promise<{ buffer: Buffer; mimeType: string }> {
  return withRetry(async () => {
    const res = await fetch(getYarnGptUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getYarnGptKey()}`,
        "Content-Type": "application/json",
        Accept: "audio/mpeg", // safer default
      },
      body: JSON.stringify({
        text,
        voice: getYarnGptVoice(),
        response_format: "mp3", // safest
      }),
    });

    if (!res.ok) {
      throw new Error(`yarngpt failed: ${res.status} ${await res.text()}`);
    }

    // ✅ STREAM PROPERLY
    const chunks: Buffer[] = [];

    for await (const chunk of res.body as any) {
      chunks.push(Buffer.from(chunk));
    }

    const buffer = Buffer.concat(chunks);

    return {
      buffer,
      mimeType: "audio/mpeg",
    };
  }, {
    label: "yarngpt.synthesizePidgin",
    attempts: 5,
    delayMs: 500
  });
}

// ─── Main voice reply function ──────
// Sends voice note when:
//   isCurrentMessageVoice == true → user sent voice → reply with voice
// Pidgin → translate via Gemini, synthesize via YarnGPT
// English / French → synthesize via OpenAI TTS
// On failure → fall back to text.
export async function sendReply(
  to: string,
  text: string,
  language: Language,
  isCurrentMessageVoice: boolean
): Promise<void> {
  const shouldSendVoice = isCurrentMessageVoice;

  if (!shouldSendVoice || !isVoiceEnabled()) {
    await sendWhatsAppText(to, text);
    return;
  }

  try {
    // Pidgin: translate English text → Pidgin, then YarnGPT.
    // English/French: synthesize directly via OpenAI TTS.
    const voiceText = language === "pidgin"
      ? await gemini.translateToPidgin(text)
      : text;

    logger.info(`[voice] lang=${language} | engine=${language === "pidgin" ? "yarngpt" : "openai"} | textLen=${voiceText.length} | sending to TTS…`);

    const audio = language === "pidgin"
      ? await synthesizePidgin(voiceText)
      : await synthesizeOpenAI(voiceText);

    logger.info(`[voice] synthesis OK | ${audio.buffer.byteLength} bytes | mime=${audio.mimeType} | uploading…`);

    const mediaId = await uploadWhatsAppMedia(audio.buffer, audio.mimeType, "reply.ogg");
    logger.info(`[voice] uploaded mediaId=${mediaId} | sending audio to ${to}…`);

    await sendWhatsAppAudio(to, mediaId);
    logger.info(`[voice] audio sent to ${to} ✓`);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      logger.info(`[voice] cancelled for ${to} (new message arrived)`);
      return;
    }
    logger.error(err, `[voice] FAILED lang=${language} | falling back to text`);
    await sendWhatsAppText(to, text);
    logger.info(`[voice] text fallback sent to ${to}`);
  }
}
