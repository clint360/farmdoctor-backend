import { complete } from "./openrouter.service";
import { toWav } from "./audio.util";
import { logger } from "../../utils/logger";

/** Speech-to-text via an audio-capable OpenRouter model (no Google Cloud STT). */
export const sttService = {
  listen: async (audioBuffer: Buffer): Promise<string> => {
    try {
      if (!audioBuffer.length) return "";
      const wav = await toWav(audioBuffer);
      return await complete({
        task: "audio",
        temperature: 0,
        maxTokens: 600,
        user: [
          { type: "audio", base64: wav.toString("base64"), format: "wav" },
          { type: "text", text: "Transcribe this audio exactly as spoken. Return ONLY the transcription text, nothing else." },
        ],
      });
    } catch (error) {
      logger.error(error, "Error transcribing audio via OpenRouter");
      throw error;
    }
  },
};
