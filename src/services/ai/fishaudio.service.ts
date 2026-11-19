import { withRetry } from "../whatsapp/retry.service";
import { logger } from "../../utils/logger";

/**
 * Fish Audio text-to-speech for English and French (Pidgin stays on YarnGPT).
 * Returns Ogg/Opus, which WhatsApp and Telegram voice notes accept directly.
 */
export type FishLanguage = "en" | "fr";

const API_URL = () => process.env.FISH_AUDIO_API_URL || "https://api.fish.audio/v1/tts";

export const isFishAudioConfigured = (): boolean => !!process.env.FISH_AUDIO_API_KEY;

function voiceFor(lang: FishLanguage): string | undefined {
  const specific = lang === "fr" ? process.env.FISH_AUDIO_VOICE_FR : process.env.FISH_AUDIO_VOICE_EN;
  return specific || process.env.FISH_AUDIO_VOICE_ID || undefined;
}

export async function synthesizeFishAudio(
  text: string,
  lang: FishLanguage,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) throw new Error("FISH_AUDIO_API_KEY is not configured");

  const reference_id = voiceFor(lang);
  const clean = text.replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();

  return withRetry(
    async () => {
      const res = await fetch(API_URL(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          model: process.env.FISH_AUDIO_MODEL || "s2.1-pro",
        },
        body: JSON.stringify({
          text: clean,
          ...(reference_id ? { reference_id } : {}),
          format: "opus",
          opus_bitrate: 32000,
          latency: "balanced",
          normalize: true,
        }),
      });
      if (!res.ok) {
        throw new Error(`fish audio failed: ${res.status} ${await res.text()}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length) throw new Error("fish audio returned empty audio");
      logger.info(`[fishaudio] lang=${lang} | ${buffer.length} bytes`);
      return { buffer, mimeType: "audio/ogg" };
    },
    { label: "fishaudio.synthesize" },
  );
}
