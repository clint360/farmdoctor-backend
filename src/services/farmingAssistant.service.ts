import sharp from "sharp";
import { logger } from "../utils/logger";
import { complete } from "./ai/openrouter.service";
import { FARM_DOCTOR_SYSTEM_PROMPT } from "./ai/systemPrompt";

export interface FarmingAdviceData {
  crop: string;
  issue: string;
  solution: string;
  tips: string;
}

export interface TranslationData {
  translatedText: string;
}

export type IntentLabel = "new_request" | "follow_up" | "gratitude" | "other";

export interface IntentResult {
  intent: IntentLabel;
}

/**
 * All generation goes through the shared OpenRouter client + shared system
 * prompt. Per-request text is passed as the user message, so requests are
 * independent and safe to run concurrently.
 */
const generateWithFallback = async (
  prompt: string,
  imagePart?: { inlineData: { data: string; mimeType: string } },
): Promise<string> =>
  complete({
    task: imagePart ? "vision" : "text",
    system: FARM_DOCTOR_SYSTEM_PROMPT,
    json: true,
    user: imagePart
      ? [
          { type: "text", text: prompt },
          { type: "image", base64: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType },
        ]
      : prompt,
  });

const pidginSystemInstruction = `You are a helpful agronomist. Speak and reply only in Cameroon Pidgin English (CamP).
Use natural Cameroon Pidgin phrasing like "how for do", "for true", and "na so" when it fits.
Keep the tone professional but warm and very conversational.
Keep each field short: 1-2 short sentences max. Avoid long lists.
Do not include any English translation.
Respond in strict JSON with the exact keys: crop, issue, solution, tips.
The keys must be in English, but the values must be in Cameroon Pidgin.
Avoid extra commentary outside the JSON.`;

const buildAdvicePrompt = (
  inputText: string,
  usePidgin: boolean,
  contextSummary?: string,
): string => {
  if (usePidgin) {
    return `${pidginSystemInstruction}

${
  contextSummary
    ? `${contextSummary}
`
    : ""
}

User input: ${inputText}`;
  }

  return `You are an expert agronomist AI.
Provide concise farming advice based on the user's description.
Sound like a helpful human, not a formal report.
Keep each field short: 1-2 short sentences max. Avoid long lists.
You MUST respond in strict JSON format with exactly these keys:
{
  "crop": "The crop being discussed (infer if not directly stated)",
  "issue": "Brief summary of the issue or diagnosis",
  "solution": "Detailed, immediate actionable steps to take",
  "tips": "Long-term preventative measures or best practices"
}

${
  contextSummary
    ? `${contextSummary}
`
    : ""
}
User input: ${inputText}`;
};

const buildImagePrompt = (usePidgin: boolean): string => {
  if (usePidgin) {
    return `${pidginSystemInstruction}

Analyze the given image of a crop and provide the response in Cameroon Pidgin JSON.`;
  }

  return `You are an expert agronomist AI.
Analyze the given image of a crop. 
Keep each field short: 1-2 short sentences max. Avoid long lists.
You MUST respond in strict JSON format with exactly these keys:
{
  "crop": "Name of the crop identified",
  "issue": "Name of the identified disease or issue (or 'None')",
  "solution": "Step-by-step actionable advice for treatment",
  "tips": "Additional preventative or general farming tips"
}`;
};

const detectImageMimeType = (
  buffer: Buffer,
  headerMimeType?: string | null,
): string => {
  const normalizedHeader = headerMimeType?.split(";")[0]?.trim() || "";
  if (normalizedHeader && normalizedHeader !== "application/octet-stream") {
    return normalizedHeader;
  }

  if (buffer.length >= 12) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      return "image/png";
    }
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return "image/webp";
    }
    if (
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38
    ) {
      return "image/gif";
    }
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return "image/bmp";
    }
  }

  return "image/jpeg";
};

const optimizeImageForAnalysis = async (
  buffer: Buffer,
  headerMimeType?: string | null,
): Promise<{ buffer: Buffer; mimeType: string }> => {
  try {
    const maxDimension = 1280;
    const quality = 80;
    const image = sharp(buffer, { failOnError: false }).rotate();
    const metadata = await image.metadata();

    let pipeline = image;
    if (metadata.width && metadata.height) {
      if (metadata.width > maxDimension || metadata.height > maxDimension) {
        pipeline = image.resize({
          width: maxDimension,
          height: maxDimension,
          fit: "inside",
          withoutEnlargement: true,
        });
      }
    }

    const optimizedBuffer = await pipeline
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

    return { buffer: optimizedBuffer, mimeType: "image/jpeg" };
  } catch (error) {
    logger.warn(error, "Image optimization failed, using original buffer");
    return {
      buffer,
      mimeType: detectImageMimeType(buffer, headerMimeType),
    };
  }
};

/**
 * Analyzes an image URL to determine crop disease and treatment.
 */
export const analyzeImage = async (
  imageUrl: string,
  options?: {
    preferredLanguage?: "en" | "fr" | "pidgin";
    contextSummary?: string;
  },
): Promise<FarmingAdviceData> => {
  try {
    const response = await fetch(imageUrl);
    const arrayBuffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    const optimizedImage = await optimizeImageForAnalysis(
      imageBuffer,
      response.headers.get("content-type"),
    );
    const base64Data = optimizedImage.buffer.toString("base64");
    const mimeType = optimizedImage.mimeType;

    const imagePart = {
      inlineData: {
        data: base64Data,
        mimeType,
      },
    };

    const usePidgin = options?.preferredLanguage === "pidgin";
    const prompt = buildImagePrompt(usePidgin);
    const responseText = await generateWithFallback(prompt, imagePart);

    return JSON.parse(responseText) as FarmingAdviceData;
  } catch (error) {
    logger.error(error, "Error analyzing crop image");
    throw error;
  }
};

/**
 * Generates structured farming advice based on user input text.
 */
export const generateAdvice = async (
  inputText: string,
  options?: {
    preferredLanguage?: "en" | "fr" | "pidgin";
    contextSummary?: string;
  },
): Promise<FarmingAdviceData> => {
  try {
    const usePidgin = options?.preferredLanguage === "pidgin";
    const prompt = buildAdvicePrompt(
      inputText,
      usePidgin,
      options?.contextSummary,
    );
    const responseText = await generateWithFallback(prompt);

    return JSON.parse(responseText) as FarmingAdviceData;
  } catch (error) {
    logger.error(error, "Error generating farming advice");
    throw error;
  }
};

/**
 * Translates simple English text into a chosen language.
 */
export const translateLanguage = async (
  text: string,
  targetLanguage: string,
): Promise<TranslationData> => {
  try {
    let languagePromptContext = `Translate the following text into ${targetLanguage}.`;

    if (
      targetLanguage.toLowerCase() === "pidgin" ||
      targetLanguage.toLowerCase() === "cameroon pidgin"
    ) {
      languagePromptContext = `You are an expert translator specializing in Cameroon Pidgin English (Francophone and Anglophone blends found in Cameroon).
Translate the following text into natural Cameroon Pidgin.`;
    }

    const prompt = `${languagePromptContext}
You MUST respond in strict JSON format with exactly these keys:
{
  "translatedText": "The final translated text"
}

Text to translate: "${text}"`;

    const responseText = await generateWithFallback(prompt);

    return JSON.parse(responseText) as TranslationData;
  } catch (error) {
    logger.error(error, `Error translating to ${targetLanguage} `);
    throw error;
  }
};

export const classifyIntent = async (
  inputText: string,
  contextSummary?: string,
): Promise<IntentResult> => {
  const prompt = `You are classifying a farmer's message.
Return a strict JSON object with one key: "intent".
Allowed values: "new_request", "follow_up", "gratitude", "other".

Rules:
- "gratitude": thanks, appreciation, closing pleasantries.
- "follow_up": user references prior advice or asks for clarification.
- "new_request": a new crop issue or new question.
- "other": greetings, unrelated chat, or unclear.

${
  contextSummary
    ? `${contextSummary}
`
    : ""
}User message: "${inputText}"`;

  try {
    const responseText = await generateWithFallback(prompt);
    const parsed = JSON.parse(responseText) as IntentResult;
    if (
      parsed?.intent === "new_request" ||
      parsed?.intent === "follow_up" ||
      parsed?.intent === "gratitude" ||
      parsed?.intent === "other"
    ) {
      return parsed;
    }
  } catch (error) {
    logger.warn(
      error,
      "Intent classification failed; defaulting to new_request",
    );
  }

  return { intent: "new_request" };
};
