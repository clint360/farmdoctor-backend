import speech from "@google-cloud/speech";
import { spawn } from "node:child_process";
import { logger } from "../../utils/logger";

const sttClient = new speech.SpeechClient();

const convertOggToLinear16 = async (
  audioBuffer: Buffer,
  sampleRate = 16000,
): Promise<Buffer> => {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "ogg",
      "-i",
      "pipe:0",
      "-ac",
      "1",
      "-ar",
      sampleRate.toString(),
      "-f",
      "s16le",
      "pipe:1",
    ]);

    const outputChunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];

    ffmpegProcess.stdout.on("data", (chunk) => outputChunks.push(chunk));
    ffmpegProcess.stderr.on("data", (chunk) => errorChunks.push(chunk));

    ffmpegProcess.on("error", (error) => reject(error));
    ffmpegProcess.on("close", (code) => {
      if (code !== 0) {
        const errorMessage = Buffer.concat(errorChunks).toString("utf-8");
        reject(new Error(`ffmpeg failed with code ${code}: ${errorMessage}`));
        return;
      }

      resolve(Buffer.concat(outputChunks));
    });

    ffmpegProcess.stdin.write(audioBuffer);
    ffmpegProcess.stdin.end();
  });
};

export const sttService = {
  listen: async (audioBuffer: Buffer): Promise<string> => {
    try {
      if (!audioBuffer.length) {
        return "";
      }

      const sampleRate = 16000;
      const linear16Audio = await convertOggToLinear16(audioBuffer, sampleRate);

      const [response] = await sttClient.recognize({
        audio: {
          content: linear16Audio.toString("base64"),
        },
        config: {
          encoding: "LINEAR16",
          sampleRateHertz: sampleRate,
          languageCode: "en-US",
          enableAutomaticPunctuation: true,
          model: "latest_long",
        },
      });

      const transcript = response.results
        ?.map((result) => result.alternatives?.[0]?.transcript || "")
        .join(" ")
        .trim();

      return transcript || "";
    } catch (error) {
      logger.error(error, "Error transcribing audio with Google Cloud STT");
      throw error;
    }
  },
};
