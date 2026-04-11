import textToSpeech from "@google-cloud/text-to-speech";
import OpenAI from "openai";
import { spawn } from "node:child_process";
import { logger } from "../../utils/logger";

const ttsClient = new textToSpeech.TextToSpeechClient(
  process.env.GOOGLE_CREDENTIALS_JSON
    ? { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON) }
    : {},
);
const openAiApiKey = process.env.OPENAI_API_KEY || "";
const openAiTtsModel = process.env.OPENAI_TTS_MODEL || "tts-1";
const openAiTtsVoice = process.env.OPENAI_TTS_VOICE || "alloy";
const openAiClient = openAiApiKey ? new OpenAI({ apiKey: openAiApiKey }) : null;

const simplifyPidginText = (text: string): string => {
  return text
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
};

type TtsLanguage = "en" | "fr" | "pidgin";

const resolveLanguageCode = (language?: TtsLanguage): string => {
  if (language === "fr") {
    return process.env.TTS_LANG_FR || "fr-FR";
  }
  if (language === "pidgin") {
    return process.env.TTS_LANG_PIDGIN || "en-NG";
  }
  return process.env.TTS_LANG_EN || "en-GB";
};

const resolveVoiceName = (language?: TtsLanguage): string | undefined => {
  if (language === "fr") {
    return process.env.TTS_VOICE_FR || undefined;
  }
  if (language === "pidgin") {
    return process.env.TTS_VOICE_PIDGIN || undefined;
  }
  return process.env.TTS_VOICE_EN || undefined;
};

const synthesizeLinear16 = async (
  text: string,
  language?: TtsLanguage,
  useVoiceName = true,
): Promise<Buffer> => {
  const languageCode = resolveLanguageCode(language);
  const voiceName = useVoiceName ? resolveVoiceName(language) : undefined;
  const [response] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode,
      ssmlGender: "NEUTRAL",
      name: voiceName,
    },
    audioConfig: {
      audioEncoding: "LINEAR16",
      sampleRateHertz: 24000,
    },
  });

  if (!response.audioContent) {
    throw new Error("Google Cloud TTS returned empty audio content.");
  }

  if (Buffer.isBuffer(response.audioContent)) {
    return response.audioContent;
  }

  return Buffer.from(response.audioContent as Uint8Array);
};

const synthesizeOpenAiWav = async (text: string): Promise<Buffer> => {
  if (!openAiClient) {
    throw new Error("OpenAI TTS is not configured.");
  }

  const response = await openAiClient.audio.speech.create({
    model: openAiTtsModel,
    voice: openAiTtsVoice,
    input: text,
    response_format: "wav",
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

const convertWavToOggOpus = async (wavBuffer: Buffer): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "wav",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-ar",
      "24000",
      "-f",
      "ogg",
      "pipe:1",
    ]);

    const outputChunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];

    ffmpegProcess.stdout.on("data", (chunk) => outputChunks.push(chunk));
    ffmpegProcess.stderr.on("data", (chunk) => errorChunks.push(chunk));

    ffmpegProcess.on("error", (error) => {
      reject(error);
    });

    ffmpegProcess.on("close", (code) => {
      if (code !== 0) {
        const errorMessage = Buffer.concat(errorChunks).toString("utf-8");
        reject(new Error(`ffmpeg failed with code ${code}: ${errorMessage}`));
        return;
      }

      resolve(Buffer.concat(outputChunks));
    });

    ffmpegProcess.stdin.write(wavBuffer);
    ffmpegProcess.stdin.end();
  });
};

export const ttsService = {
  speak: async (text: string, language?: TtsLanguage): Promise<Buffer> => {
    try {
      const normalizedText = simplifyPidginText(text);
      if (!normalizedText) {
        return Buffer.from("");
      }

      let wavBuffer: Buffer;
      if (openAiClient) {
        try {
          wavBuffer = await synthesizeOpenAiWav(normalizedText);
          return await convertWavToOggOpus(wavBuffer);
        } catch (error: any) {
          logger.warn({ message: error?.message, status: error?.status, code: error?.code }, "OpenAI TTS failed, falling back to Google TTS");
        }
      } else {
        logger.info("OpenAI TTS skipped: OPENAI_API_KEY not set");
      }

      try {
        wavBuffer = await synthesizeLinear16(normalizedText, language, true);
      } catch (error) {
        const voiceName = resolveVoiceName(language);
        if (voiceName) {
          logger.warn(
            { voiceName },
            "Configured TTS voice failed, retrying with default voice",
          );
          wavBuffer = await synthesizeLinear16(normalizedText, language, false);
        } else {
          throw error;
        }
      }
      return await convertWavToOggOpus(wavBuffer);
    } catch (error) {
      logger.error(error, "Error synthesizing speech with Google Cloud TTS");
      throw error;
    }
  },
};
