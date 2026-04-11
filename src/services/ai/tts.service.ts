import textToSpeech from "@google-cloud/text-to-speech";
import OpenAI from "openai";
import { spawn } from "node:child_process";
import { logger } from "../../utils/logger";

const ttsClient = new textToSpeech.TextToSpeechClient();
const openAiApiKey = process.env.OPENAI_API_KEY || "";
const openAiTtsModel = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const openAiTtsVoice = process.env.OPENAI_TTS_VOICE || "alloy";
const openAiTtsVoiceMale = process.env.OPENAI_TTS_VOICE_MALE;
const openAiTtsVoiceFemale = process.env.OPENAI_TTS_VOICE_FEMALE;
const openAiClient = openAiApiKey ? new OpenAI({ apiKey: openAiApiKey }) : null;

const simplifyPidginText = (text: string): string => {
  return text
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
};

type TtsLanguage = "en" | "fr" | "pidgin";
type TtsGender = "male" | "female" | "neutral";

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

const resolveGender = (gender?: TtsGender): "MALE" | "FEMALE" | "NEUTRAL" => {
  if (gender === "male") return "MALE";
  if (gender === "female") return "FEMALE";
  return "NEUTRAL";
};

const resolveOpenAiVoice = (gender?: TtsGender): string => {
  if (gender === "male" && openAiTtsVoiceMale) return openAiTtsVoiceMale;
  if (gender === "female" && openAiTtsVoiceFemale) return openAiTtsVoiceFemale;
  return openAiTtsVoice;
};

const synthesizeLinear16 = async (
  text: string,
  language?: TtsLanguage,
  gender?: TtsGender,
  useVoiceName = true,
): Promise<Buffer> => {
  const languageCode = resolveLanguageCode(language);
  const voiceName = useVoiceName ? resolveVoiceName(language) : undefined;
  const [response] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode,
      ssmlGender: resolveGender(gender),
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

const synthesizeOpenAiWav = async (
  text: string,
  voice: string,
): Promise<Buffer> => {
  if (!openAiClient) {
    throw new Error("OpenAI TTS is not configured.");
  }

  const response = await openAiClient.audio.speech.create({
    model: openAiTtsModel,
    voice,
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
  speak: async (
    text: string,
    language?: TtsLanguage,
    options?: { gender?: TtsGender },
  ): Promise<Buffer> => {
    try {
      const normalizedText = simplifyPidginText(text);
      if (!normalizedText) {
        return Buffer.from("");
      }

      let wavBuffer: Buffer;
      if (openAiClient) {
        try {
          const voice = resolveOpenAiVoice(options?.gender);
          wavBuffer = await synthesizeOpenAiWav(normalizedText, voice);
          return await convertWavToOggOpus(wavBuffer);
        } catch (error) {
          logger.warn(error, "OpenAI TTS failed, falling back to Google TTS");
        }
      }

      try {
        wavBuffer = await synthesizeLinear16(
          normalizedText,
          language,
          options?.gender,
          true,
        );
      } catch (error) {
        const voiceName = resolveVoiceName(language);
        if (voiceName) {
          logger.warn(
            { voiceName },
            "Configured TTS voice failed, retrying with default voice",
          );
          wavBuffer = await synthesizeLinear16(
            normalizedText,
            language,
            options?.gender,
            false,
          );
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
