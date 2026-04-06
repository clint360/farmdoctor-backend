import {
  analyzeImage,
  generateAdvice,
  translateLanguage,
  FarmingAdviceData,
} from "./farmingAssistant.service";
import { sttService } from "./ai/stt.service";
import { ttsService } from "./ai/tts.service";
import { logger } from "../utils/logger";

export interface MessageRequest {
  type: "text" | "image" | "voice";
  /**
   * The actual text payload, an accessible public URL to the image file,
   * or an audio buffer for voice notes.
   */
  content: string | Buffer;
  preferredLanguage?: "en" | "fr" | "pidgin";
  wantsAudio?: boolean;
}

export interface ProcessedResponse {
  structuredAdvice: FarmingAdviceData;
  finalMessageText: string;
  audioBuffer?: Buffer;
}

const formatAdviceMessage = (advice: FarmingAdviceData): string => {
  return [
    `Crop: ${advice.crop}`,
    `Diagnosis: ${advice.issue}`,
    "",
    "Action needed:",
    advice.solution.trim(),
    "",
    "Tips:",
    advice.tips.trim(),
    "",
    "If you need more details, reply with a short follow-up.",
  ].join("\n");
};

const buildFallbackAdvice = (): FarmingAdviceData => ({
  crop: "Unknown",
  issue: "Service temporarily unavailable",
  solution:
    "Please retry in a few minutes. Our AI service is temporarily busy.",
  tips: "If this is urgent, consider consulting a local extension officer while we recover.",
});

const buildFallbackMessage = (
  preferredLanguage?: MessageRequest["preferredLanguage"],
): string => {
  if (preferredLanguage === "fr") {
    return "Le service est temporairement indisponible. Veuillez reessayer dans quelques minutes.";
  }

  if (preferredLanguage === "pidgin") {
    return "Service no dey now. Try back after small time.";
  }

  return "The service is temporarily unavailable. Please try again in a few minutes.";
};

/**
 * Orchestrator service that processes incoming multimedia messages, evaluates them via AI,
 * optional translates the results, and optionally generates TTS.
 */
export const processFarmerMessage = async (
  req: MessageRequest,
): Promise<ProcessedResponse> => {
  let advice: FarmingAdviceData;

  logger.info(
    { messageType: req.type, language: req.preferredLanguage },
    "Starting message processing pipeline",
  );

  try {
    // 1. Detect message type and generate initial advice
    if (req.type === "image") {
      advice = await analyzeImage(req.content);
    } else if (req.type === "voice") {
      if (typeof req.content === "string") {
        throw new Error("Voice requests must provide an audio buffer.");
      }

      const transcribedText = await sttService.listen(req.content);
      logger.info(
        { transcribedText },
        "Successfully transcribed voice message",
      );
      advice = await generateAdvice(transcribedText);
    } else {
      if (typeof req.content !== "string") {
        throw new Error("Text requests must provide a string payload.");
      }

      advice = await generateAdvice(req.content);
    }

    // Combine structured response into a human readable format
    let finalMessageText = formatAdviceMessage(advice);

    // 2. Translate if necessary
    if (req.preferredLanguage && req.preferredLanguage !== "en") {
      let langParam = "English";
      if (req.preferredLanguage === "pidgin") langParam = "Cameroon Pidgin";
      if (req.preferredLanguage === "fr") langParam = "French";

      const translation = await translateLanguage(finalMessageText, langParam);
      finalMessageText = translation.translatedText;
    }

    // 3. Optionally synthesize audio
    let audioBuffer: Buffer | undefined;
    if (req.wantsAudio) {
      audioBuffer = await ttsService.speak(
        finalMessageText,
        req.preferredLanguage,
      );
    }

    return {
      structuredAdvice: advice,
      finalMessageText,
      audioBuffer,
    };
  } catch (error) {
    logger.error(error, "Error executing farmer message processing pipeline");
    return {
      structuredAdvice: buildFallbackAdvice(),
      finalMessageText: buildFallbackMessage(req.preferredLanguage),
    };
  }
};
