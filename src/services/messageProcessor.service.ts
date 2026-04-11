import {
  analyzeImage,
  generateAdvice,
  translateLanguage,
  FarmingAdviceData,
  classifyIntent,
} from "./farmingAssistant.service";
import { sttService } from "./ai/stt.service";
import { ttsService } from "./ai/tts.service";
import { logger } from "../utils/logger";
import { getLatestInteraction } from "./interaction.service";

export interface MessageRequest {
  type: "text" | "image" | "voice";
  userId?: string;
  /**
   * The actual text payload, an accessible public URL to the image file,
   * or an audio buffer for voice notes.
   */
  content: string | Buffer;
  preferredLanguage?: "en" | "fr" | "pidgin";
  wantsAudio?: boolean;
  ttsGender?: "male" | "female" | "neutral";
}

export interface ProcessedResponse {
  structuredAdvice: FarmingAdviceData;
  finalMessageText: string;
  audioBuffer?: Buffer;
  userText?: string;
  shouldLogInteraction?: boolean;
}

const normalizeText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
};

const toBullets = (text: unknown): string => {
  const trimmed = normalizeText(text).trim();
  if (!trimmed) {
    return "- ";
  }

  let parts = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    parts = trimmed
      .split(/\.(\s+|$)/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  return parts.map((line) => `- ${line}`).join("\n");
};

const formatAdviceMessage = (
  advice: FarmingAdviceData,
  language?: MessageRequest["preferredLanguage"],
): string => {
  const crop = (advice.crop || "").trim() || "your crop";
  const issue = (advice.issue || "").trim() || "a problem";
  const solution = normalizeText(advice.solution).trim();
  const tips = normalizeText(advice.tips).trim();

  if (language === "pidgin") {
    const parts = [`E be like say your ${crop} get ${issue}.`];
    if (solution) parts.push(solution);
    if (tips) parts.push(tips);
    return parts.join(" ");
  }

  if (language === "fr") {
    const parts = [`Il semble que votre ${crop} a ${issue}.`];
    if (solution) parts.push(solution);
    if (tips) parts.push(tips);
    return parts.join(" ");
  }

  const parts = [`It looks like your ${crop} has ${issue}.`];
  if (solution) parts.push(solution);
  if (tips) parts.push(tips);
  return parts.join(" ");
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

const buildAcknowledgementMessage = (
  preferredLanguage?: MessageRequest["preferredLanguage"],
): string => {
  if (preferredLanguage === "pidgin") {
    return "Thanks! If you get any other question, just tell me.";
  }

  if (preferredLanguage === "fr") {
    return "Merci. Si vous avez une autre question, dites-le moi.";
  }

  return "Thanks. If you have another question, just tell me.";
};

const buildClarifyMessage = (
  preferredLanguage?: MessageRequest["preferredLanguage"],
): string => {
  if (preferredLanguage === "pidgin") {
    return "I fit help. Tell me the crop and wetin you see, or send photo/voice.";
  }

  if (preferredLanguage === "fr") {
    return "Je peux aider. Dites-moi la culture et ce que vous voyez, ou envoyez une photo/voix.";
  }

  return "I can help. Tell me the crop and what you see, or send a photo/voice note.";
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
    const lastInteraction = await getLatestInteraction(req.userId);
    const contextSummary = lastInteraction
      ? `Previous context: crop=${lastInteraction.crop}, issue=${lastInteraction.issue}.${
          lastInteraction.lastUserText
            ? ` Last user message: "${lastInteraction.lastUserText}".`
            : ""
        }${
          lastInteraction.lastAssistantText
            ? ` Last reply: "${lastInteraction.lastAssistantText}".`
            : ""
        }`
      : undefined;

    let userText: string | undefined;

    // 1. Detect message type and generate initial advice
    if (req.type === "image") {
      if (typeof req.content !== "string") {
        throw new Error(
          "Image requests must provide a public image URL string.",
        );
      }

      userText = "Image provided";
      advice = await analyzeImage(req.content, {
        preferredLanguage: req.preferredLanguage,
        contextSummary,
      });
    } else if (req.type === "voice") {
      if (typeof req.content === "string") {
        throw new Error("Voice requests must provide an audio buffer.");
      }

      const transcribedText = await sttService.listen(req.content);
      logger.info(
        { transcribedText },
        "Successfully transcribed voice message",
      );
      userText = transcribedText;

      const intentResult = await classifyIntent(
        transcribedText,
        contextSummary,
      );
      if (intentResult.intent === "gratitude") {
        return {
          structuredAdvice: buildFallbackAdvice(),
          finalMessageText: buildAcknowledgementMessage(req.preferredLanguage),
          userText,
          shouldLogInteraction: false,
        };
      }
      if (intentResult.intent === "other") {
        return {
          structuredAdvice: buildFallbackAdvice(),
          finalMessageText: buildClarifyMessage(req.preferredLanguage),
          userText,
          shouldLogInteraction: false,
        };
      }

      advice = await generateAdvice(transcribedText, {
        preferredLanguage: req.preferredLanguage,
        contextSummary,
      });
    } else {
      if (typeof req.content !== "string") {
        throw new Error("Text requests must provide a string payload.");
      }

      userText = req.content;

      const intentResult = await classifyIntent(req.content, contextSummary);
      if (intentResult.intent === "gratitude") {
        return {
          structuredAdvice: buildFallbackAdvice(),
          finalMessageText: buildAcknowledgementMessage(req.preferredLanguage),
          userText,
          shouldLogInteraction: false,
        };
      }
      if (intentResult.intent === "other") {
        return {
          structuredAdvice: buildFallbackAdvice(),
          finalMessageText: buildClarifyMessage(req.preferredLanguage),
          userText,
          shouldLogInteraction: false,
        };
      }

      advice = await generateAdvice(req.content, {
        preferredLanguage: req.preferredLanguage,
        contextSummary,
      });
    }

    // Combine structured response into a human readable format
    let finalMessageText = formatAdviceMessage(advice, req.preferredLanguage);

    // 2. Translate if necessary
    if (req.preferredLanguage === "fr") {
      let langParam = "English";
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
        { gender: req.ttsGender },
      );
    }

    return {
      structuredAdvice: advice,
      finalMessageText,
      audioBuffer,
      userText,
      shouldLogInteraction: true,
    };
  } catch (error) {
    logger.error(error, "Error executing farmer message processing pipeline");
    return {
      structuredAdvice: buildFallbackAdvice(),
      finalMessageText: buildFallbackMessage(req.preferredLanguage),
    };
  }
};
