import { GoogleGenerativeAI } from "@google/generative-ai";
import { VertexAI } from "@google-cloud/vertexai";
import sharp from "sharp";
import { logger } from "../utils/logger";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const vertexProjectId = process.env.VERTEX_PROJECT_ID || "";
const vertexLocation = process.env.VERTEX_LOCATION || "us-central1";
const vertexModelName = process.env.VERTEX_GEMINI_MODEL || "gemini-1.5-flash";
let vertexAI: VertexAI | null = null;

export interface FarmingAdviceData {
  crop: string;
  issue: string;
  solution: string;
  tips: string;
}

export interface TranslationData {
  translatedText: string;
}

const getJsonModel = () => {
  return genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
    },
  });
};

const getVertexModel = () => {
  if (!vertexProjectId) {
    return null;
  }

  if (!vertexAI) {
    vertexAI = new VertexAI({
      project: vertexProjectId,
      location: vertexLocation,
    });
  }

  return vertexAI.getGenerativeModel({
    model: vertexModelName,
    generationConfig: {
      responseMimeType: "application/json",
    },
  });
};

const extractVertexText = (vertexResult: any): string => {
  const parts = vertexResult?.response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const merged = parts
      .map((part: any) => part?.text || "")
      .join("")
      .trim();
    if (merged) {
      return merged;
    }
  }

  const responseText = vertexResult?.response?.text?.();
  if (typeof responseText === "string" && responseText.trim()) {
    return responseText;
  }

  return "";
};

const generateWithFallback = async (
  prompt: string,
  imagePart?: { inlineData: { data: string; mimeType: string } },
) => {
  const model = getJsonModel();

  try {
    const result = await withGeminiRetry(() =>
      model.generateContent(imagePart ? [prompt, imagePart] : prompt),
    );
    return result.response.text();
  } catch (error) {
    const vertexModel = getVertexModel();
    if (!vertexModel) {
      logger.warn(
        "Vertex AI fallback is not configured; rethrowing Gemini error.",
      );
      throw error;
    }

    logger.warn(error, "Gemini API failed, falling back to Vertex AI");
    const parts = imagePart
      ? [{ text: prompt }, imagePart]
      : [{ text: prompt }];
    const vertexResult = await vertexModel.generateContent({
      contents: [{ role: "user", parts }],
    });
    const vertexText = extractVertexText(vertexResult);
    if (!vertexText) {
      throw new Error("Vertex AI returned an empty response.");
    }
    return vertexText;
  }
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

    const prompt = `You are an expert agronomist AI.
Analyze the given image of a crop. 
You MUST respond in strict JSON format with exactly these keys:
{
  "crop": "Name of the crop identified",
  "issue": "Name of the identified disease or issue (or 'None')",
  "solution": "Step-by-step actionable advice for treatment",
  "tips": "Additional preventative or general farming tips"
}`;

    const responseText = await generateWithFallback(prompt, imagePart);

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
): Promise<FarmingAdviceData> => {
  try {
    const prompt = `You are an expert agronomist AI.
Provide detailed farming advice based on the user's description.
You MUST respond in strict JSON format with exactly these keys:
{
  "crop": "The crop being discussed (infer if not directly stated)",
  "issue": "Brief summary of the issue or diagnosis",
  "solution": "Detailed, immediate actionable steps to take",
  "tips": "Long-term preventative measures or best practices"
}

User input: ${inputText}`;

    const responseText = await generateWithFallback(prompt);

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
