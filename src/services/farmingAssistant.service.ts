import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import sharp from "sharp";
import { logger } from "../utils/logger";

const vertexProjectId = process.env.VERTEX_PROJECT_ID || "";
const vertexLocation = process.env.VERTEX_LOCATION || "us-central1";
const vertexModelName = process.env.VERTEX_GEMINI_MODEL || "gemini-2.5-flash";
let vertexAI: GoogleGenAI | null = null;
const geminiApiKey = process.env.GEMINI_API_KEY || "";
let geminiAI: GoogleGenAI | null = null;
const getGeminiAI = (): GoogleGenAI | null => {
  if (!geminiApiKey) return null;
  if (!geminiAI) geminiAI = new GoogleGenAI({ apiKey: geminiApiKey });
  return geminiAI;
};
const openAiApiKey = process.env.OPENAI_API_KEY || "";
const openAiTextModel = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
const openAiVisionModel = process.env.OPENAI_VISION_MODEL || openAiTextModel;
const openAiClient = openAiApiKey ? new OpenAI({ apiKey: openAiApiKey }) : null;

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

const getVertexClient = () => {
  if (!vertexProjectId) {
    return null;
  }

  if (!vertexAI) {
    vertexAI = new GoogleGenAI({
      vertexai: true,
      project: vertexProjectId,
      location: vertexLocation,
    });
  }

  return vertexAI;
};

const generateWithClient = async (
  client: GoogleGenAI,
  modelName: string,
  prompt: string,
  imagePart?: { data: string; mimeType: string },
): Promise<string> => {
  const parts = imagePart
    ? [{ text: prompt }, { inlineData: imagePart }]
    : [{ text: prompt }];

  const response = await client.models.generateContent({
    model: modelName,
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
    },
  });

  if (!response.text) {
    throw new Error("Gemini returned an empty response.");
  }

  return response.text;
};

const generateWithOpenAI = async (
  prompt: string,
  imagePart?: { data: string; mimeType: string },
  modelName?: string,
): Promise<string> => {
  if (!openAiClient) {
    throw new Error("OpenAI is not configured.");
  }

  const model = modelName || openAiTextModel;
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [{ type: "text", text: prompt }];

  if (imagePart?.data && imagePart?.mimeType) {
    const dataUrl = `data:${imagePart.mimeType};base64,${imagePart.data}`;
    content.push({ type: "image_url", image_url: { url: dataUrl } });
  }

  const response = await openAiClient.chat.completions.create({
    model,
    messages: [{ role: "user", content }],
    temperature: 0.4,
  });

  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OpenAI returned an empty response.");
  }

  return text;
};

const generateWithFallback = async (
  prompt: string,
  imagePart?: { inlineData: { data: string; mimeType: string } },
  modelName?: string,
) => {
  const resolvedModelName = modelName || "gemini-2.5-flash";

  // Try Vertex AI first (preferred)
  const vertexClient = getVertexClient();
  if (vertexClient) {
    try {
      return await withGeminiRetry(() =>
        generateWithClient(
          vertexClient,
          modelName || vertexModelName,
          prompt,
          imagePart?.inlineData,
        ),
      );
    } catch (vertexError) {
      logger.warn(vertexError, "Vertex AI failed, trying API key fallback");
    }
  }

  // Fall back to API key
  const apiKeyClient = getGeminiAI();
  if (apiKeyClient) {
    try {
      return await withGeminiRetry(() =>
        generateWithClient(
          apiKeyClient,
          resolvedModelName,
          prompt,
          imagePart?.inlineData,
        ),
      );
    } catch (error) {
      logger.warn(error, "Gemini API key failed, trying OpenAI fallback");
    }
  }

  // Final fallback: OpenAI
  return await generateWithOpenAI(
    prompt,
    imagePart?.inlineData,
    imagePart ? openAiVisionModel : openAiTextModel,
  );
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const extractRetryDelayMs = (error: any, fallbackMs = 45000): number => {
  const retryInfo = error?.errorDetails?.find(
    (detail: any) => detail?.retryDelay,
  );
  const retryDelay = retryInfo?.retryDelay as string | undefined;

  if (retryDelay) {
    const secondsMatch = retryDelay.match(/(\d+(?:\.\d+)?)s/);
    if (secondsMatch) {
      const seconds = Number.parseFloat(secondsMatch[1]);
      if (Number.isFinite(seconds)) {
        return Math.ceil(seconds * 1000);
      }
    }
  }

  return fallbackMs;
};

const withGeminiRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error: any) {
    if (error?.status === 429) {
      const delayMs = extractRetryDelayMs(error);
      logger.warn({ delayMs }, "Gemini quota hit, retrying after delay");
      await sleep(delayMs);
      return await operation();
    }
    throw error;
  }
};

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
    const modelName = usePidgin ? "gemini-2.5-pro" : undefined;
    const responseText = await generateWithFallback(
      prompt,
      imagePart,
      modelName,
    );

    return JSON.parse(responseText) as FarmingAdviceData;
  } catch (error) {
    logger.error(error, "Error analyzing crop image using Gemini");
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
    const modelName = usePidgin ? "gemini-2.5-pro" : undefined;
    const responseText = await generateWithFallback(
      prompt,
      undefined,
      modelName,
    );

    return JSON.parse(responseText) as FarmingAdviceData;
  } catch (error) {
    logger.error(error, "Error generating farming advice using Gemini");
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
    logger.error(error, `Error translating to ${targetLanguage} using Gemini`);
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
