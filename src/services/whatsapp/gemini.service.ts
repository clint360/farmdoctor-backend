import { GoogleGenAI } from "@google/genai";
import { logger } from "../../utils/logger";

// ─── Config ─────────────────────────
const getTextModel = () => process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const getVisionModel = () =>
  process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";
const getDefaultCountry = () => process.env.DEFAULT_COUNTRY || "Cameroon";

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (!_client) {
    const vertexProject = process.env.VERTEX_PROJECT_ID;
    const vertexLocation = process.env.VERTEX_LOCATION || "us-central1";
    if (vertexProject) {
      _client = new GoogleGenAI({
        vertexai: true,
        project: vertexProject,
        location: vertexLocation,
      });
    } else {
      _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
    }
  }
  return _client;
}

// ─── Types ──────────────────────────
export type Language = "english" | "french" | "pidgin";

export type ConversationContext = {
  language: Language;
  city?: string | null;
  lastCrop?: string | null;
  lastDiagnosis?: string | null;
  lastTreatment?: string | null;
  cropTypes?: string[] | null;
  summary?: string | null;
  lastMessage?: string | null;
};

export type ImageDiagnosis = {
  cropType: string | null;
  disease: string | null;
  deficiency: string | null;
  confidence: number | null;
  explanation: string;
  treatment: string;
};

export type ChatResponse = {
  special_request?: "expert" | "insight" | null;
  reply: string;
};

// ─── System prompt ──────────────────
const SYSTEM_PROMPT = `You are Farm Doctor — a warm and opstimistic agricultural AI assistant helping farmers across Cameroon.

You genuinely care about every farmer's success. Always reply in the user's preferred language (English, French, or Cameroon Pidgin).

YOUR PERSONALITY:
- Use a few encouraging phrases "Don't worry, we can figure this out!", "This is treatable!", "Your crops can recover!"
- Never be cold, clinical, or discouraging. Even with bad diagnoses, focus on what CAN be done.
- Keep a conversational, human tone — like a wise, friendly neighbor who studied agriculture. but note that not all messages need an "Ah or don't worry" — only use them when appropriate to the situation and language."
- for technical asks, be quite straightfoward and consise, but still warm.

YOUR DIAGNOSTIC APPROACH:
- When a farmer describes symptoms, give an overview of the most likely possibilities BEFORE asking follow-up questions.
  Example: "From what you're describing, it could be a few things. If the black spots on the leaves are hard and dry, it might be early blight. If they are soft and mushy, it could be bacterial leaf spot. Can you tell me — are the spots hard or soft to the touch?"
- This way the farmer understands WHY you're asking and feels guided, not interrogated.
- Always explain the reasoning behind your questions so farmers learn alongside the diagnosis.
- Ask ONE clear follow-up question at a time. Don't overwhelm with multiple questions.

YOUR RESPONSIBILITIES:
- Diagnose crop diseases from descriptions and images
- Identify nutrient deficiencies
- Suggest locally available treatments (brands and inputs found in Cameroon)
- Give simple step-by-step farming advice anyone can follow
- Avoid technical jargon — explain like you're talking to a friend
- Use stored conversation memory and farmer location when suggesting treatments
- Never invent chemicals or products that are not available locally
- If unsure, be honest and ask for more information or a photo
- Don't be verbose if you don't have to
- Keep replies concise, straigthfoward but helpful — under 1500 characters
- If conversation history is provided, continue naturally — never re-introduce yourself or repeat greetings
- When the situation is serious, gently recommend they consult a local expert for in-person help`;

function buildContextBlock(ctx: ConversationContext): string {
  const lines: string[] = [];
  lines.push(`User preferred language: ${ctx.language}`);
  if (ctx.city)
    lines.push(`User location: ${ctx.city}, ${getDefaultCountry()}`);
  if (ctx.cropTypes && ctx.cropTypes.length > 0) {
    lines.push(`User grows: ${ctx.cropTypes.join(", ")}`);
  }
  if (ctx.lastCrop) lines.push(`Last crop discussed: ${ctx.lastCrop}`);
  if (ctx.lastDiagnosis) lines.push(`Last diagnosis: ${ctx.lastDiagnosis}`);
  if (ctx.lastTreatment)
    lines.push(`Last treatment suggested: ${ctx.lastTreatment}`);
  lines.push("");
  if (ctx.language === "pidgin") {
    lines.push(
      `IMPORTANT: Reply entirely in natural Cameroon Pidgin English (Kamtok). Use authentic vocabulary: "wetin" (what), "dey" (is/are), "sabi" (know), "chop" (eat), "waka" (go), "abeg" (please), "no wahala" (no problem), "e don" (it has), "make you" (you should), "na" (it is), "dem" (they), "plenty" (many), "small small" (gradually), "sharp sharp" (quickly), "kontri" (country/area), "pikin" (small/child), "palava" (problem). Keep it short and conversational. Only recommend treatments available in Cameroon.`
    );
  } else {
    lines.push(
      `IMPORTANT: Reply entirely in ${ctx.language}. Only recommend treatments, brands, and agro-inputs available in Cameroon.`,
    );
  }

  if (ctx.summary) {
    lines.push("");
    lines.push("--- Conversation summary ---");
    lines.push(ctx.summary);
    lines.push("--- End of summary ---");
  }
  if (ctx.lastMessage) {
    lines.push("");
    lines.push(`Last bot reply: ${ctx.lastMessage}`);
  }

  return lines.join("\n");
}

// ─── Chat ───────────────────────────
export async function chat(
  userMessage: string,
  ctx: ConversationContext,
): Promise<ChatResponse> {
  const hasPrior = ctx.summary || ctx.lastMessage;
  const prompt = `${buildContextBlock(ctx)}\n\n${hasPrior ? "Continue the conversation." : ""} Farmer says: ${userMessage}`;

  // Updated system prompt with special request detection
  const updatedSystemPrompt =
    SYSTEM_PROMPT +
    `

---

SPECIAL REQUEST DETECTION:
After generating your reply, also detect if the farmer is making one of these special requests:
1. EXPERT REQUEST: User is asking to find/connect with agricultural experts, consultants, or specialists nearby. Examples: "Connect me with experts", "I need professional help", "Where are the farm advisors", "Show me experts in my area"
2. INSIGHT REQUEST: User is asking for information/advice about crops in their specific region/location. Examples: "How to grow cassava in Bafoussam?", "What's best for this area?", "Tips for farming here", "What crops work in Douala?"

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{\n  "specialRequest": "expert" | "insight" | null,\n  "reply": "Your full conversational response here..."\n}

If the message is none of these special requests, set specialRequest to null.
ALWAYS include the "reply" field with your normal farming advice/response.`;

  const result = await client().models.generateContent({
    model: getTextModel(),
    contents: [
      {
        role: "user",
        parts: [{ text: `${updatedSystemPrompt}\n\n${prompt}` }],
      },
    ],
  });

  const raw = (result.text ?? "").trim();

  // Strip markdown code fences
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // Try full JSON parse first
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.reply) {
      return {
        special_request: parsed.specialRequest || null,
        reply: parsed.reply,
      };
    }
  } catch {
    // fall through to regex extraction
  }

  // Fallback: extract "reply" value with regex in case newlines broke JSON.parse
  const replyMatch = cleaned.match(/"reply"\s*:\s*"([\s\S]*?)"\s*[,}]/);
  if (replyMatch) {
    const specialMatch = cleaned.match(
      /"specialRequest"\s*:\s*"(expert|insight)"/,
    );
    return {
      special_request: (specialMatch?.[1] as "expert" | "insight") || null,
      reply: replyMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'),
    };
  }

  // Final fallback: return raw text as-is
  return {
    special_request: null,
    reply: cleaned,
  };
}

// ─── Vision diagnosis ───────────────
export async function diagnoseImage(
  imageBuffer: Buffer,
  mimeType: string,
  ctx: ConversationContext,
): Promise<ImageDiagnosis> {
  const imagePart = {
    inlineData: {
      data: imageBuffer.toString("base64"),
      mimeType,
    },
  };

  const prompt = `${SYSTEM_PROMPT}\n\n${buildContextBlock(ctx)}

Analyze this crop image.

Return ONLY a valid JSON object (no markdown, no commentary, no code fences) with this exact shape:
{
  "cropType": string | null,
  "disease": string | null,
  "deficiency": string | null,
  "confidence": number between 0 and 1,
  "explanation": string written in ${ctx.language === "pidgin" ? "english" : ctx.language},
  "treatment": string written in ${ctx.language === "pidgin" ? "english" : ctx.language}
}

Only suggest treatments available in Cameroon.
Avoid technical jargon.
Be concise and practical.`;

  const result = await client().models.generateContent({
    model: getVisionModel(),
    contents: [{ role: "user", parts: [{ text: prompt }, imagePart] }],
  });
  const raw = (result.text ?? "").trim();

  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as ImageDiagnosis;
    return {
      cropType: parsed.cropType ?? null,
      disease: parsed.disease ?? null,
      deficiency: parsed.deficiency ?? null,
      confidence:
        typeof parsed.confidence === "number" ? parsed.confidence : null,
      explanation: parsed.explanation ?? "",
      treatment: parsed.treatment ?? "",
    };
  } catch {
    return {
      cropType: null,
      disease: null,
      deficiency: null,
      confidence: null,
      explanation: raw,
      treatment: "",
    };
  }
}

// ─── Explain diagnosis to farmer ────
export async function explainDiagnosisToFarmer(
  diagnosis: ImageDiagnosis,
  ctx: ConversationContext,
): Promise<string> {
  if (diagnosis.explanation && diagnosis.treatment) {
    const header =
      diagnosis.cropType && diagnosis.disease
        ? `*${diagnosis.cropType}* — ${diagnosis.disease} \n`
        : (diagnosis.cropType ?? "");
    return [header, diagnosis.explanation, "/n", diagnosis.treatment]
      .filter(Boolean)
      .join("\n");
  }

  const prompt = `${SYSTEM_PROMPT}\n\n${buildContextBlock(ctx)}

Given this crop diagnosis JSON, write a well whatsapp formatted formal farmer-facing reply (use *enclose text* for bold text and _enclose_ text for emphasis) entirely in ${ctx.language === "pidgin" ? "english" : ctx.language}.
Be concise. Mention: what you see, why it matters, and what to do.
Recommend only treatments available in Cameroon.

${JSON.stringify(diagnosis)}`;

  const result = await client().models.generateContent({
    model: getTextModel(),
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
  return (result.text ?? "").trim();
}

// ─── Summarise conversation history ─
export async function summarizeHistory(
  messages: Array<{ direction: "in" | "out"; body: string | null }>,
): Promise<string> {
  const lines = messages
    .filter((m) => m.body)
    .map((m) => `${m.direction === "in" ? "Farmer" : "FarmDoctor"}: ${m.body}`)
    .join("\n");

  if (!lines) return "";

  try {
    const result = await client().models.generateContent({
      model: getTextModel(),
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Summarise the following farmer–bot conversation in 2–4 sentences. Focus on: what crop/problem was discussed, what advice was given, and any pending questions. Be factual and concise. No greetings.\n\n${lines}`,
            },
          ],
        },
      ],
    });
    return (result.text ?? "").trim();
  } catch (err) {
    logger.error(err, "summarizeHistory failed");
    return "";
  }
}

// ─── Transcribe audio + detect language ─
const TRANSCRIBE_PROMPT = `You are a Cameroon language expert. Listen to this audio carefully and do TWO things:

1. **Transcribe** exactly as spoken — preserve the original dialect, grammar, and vocabulary.
   DO NOT correct grammar or vocabulary into standard English.
   If the speaker uses Cameroon Pidgin English (Kamtok), keep ALL Pidgin words and patterns intact.

   Common Cameroon Pidgin vocabulary to listen for:
   - Greetings/discourse: "how far", "how body", "a di fine", "wetin", "oya"
   - Verbs: "sabi" (know), "chop" (eat), "waka" (walk/go), "tok" (talk), "dey" (is/progressive),
     "get" (have), "fit" (can), "don" (already), "go" (will/future), "bin" (past tense),
     "di" (progressive, like "I di go" = I am going), "make" (let/should), "giv" (give),
     "bring" (bring), "lef" (leave), "come" (come)
   - Nouns: "pikin" (child), "palava" (problem), "kontri" (country/village), "moni" (money),
     "chop" (food), "mami" (mother/woman), "papa" (father), "masa" (sir/boss), "nyanga" (style/show-off)
   - Adjectives/adverbs: "plenty" (many/much), "small" (little), "quick" (fast), "fine" (good/beautiful),
     "strong" (hard/difficult), "so-so" (only/just), "well well" (very much)
   - Particles/markers: "na" (is/it is/that is), "no be" (is not), "sef" (even/self),
     "dem" (them/plural), "am" (him/her/it object), "wey" (which/that/who), "for" (to/in/at),
     "dis" (this), "dat" (that), "e" (he/she/it), "yi" (his/her), "we" (where), "as" (because/since)
   - Expressions: "e be like say" (it seems), "I no know" (I don't know), "no wahala" (no problem),
     "a beg" (please), "na so" (that's how it is), "wusai" (where), "which kain" (what kind)

   For example, if you hear someone say the Pidgin equivalent of "I am going to eat",
   transcribe it as "a di go chop" NOT "I am going to eat".

2. **Detect the language**: exactly one of "english", "french", or "pidgin".
   - "pidgin" = Cameroon Pidgin English / Kamtok / West African Creole
   - "french" = French or Cameroonian French
   - "english" = standard English (clear grammar, no Pidgin markers)
   - When in DOUBT between English and Pidgin, choose "pidgin".

Reply in EXACTLY this format (two lines, nothing else):
LANG: <language>
TEXT: <transcription>`;

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
): Promise<{ transcript: string; language: Language }> {
  try {
    const result = await client().models.generateContent({
      model: getTextModel(),
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: mimeType || "audio/ogg",
                data: audioBuffer.toString("base64"),
              },
            },
            { text: TRANSCRIBE_PROMPT },
          ],
        },
      ],
    });

    const raw = (result.text ?? "").trim();
    logger.info(`[transcribeAudio] raw response: ${raw.slice(0, 300)}`);

    const langMatch = raw.match(/^LANG:\s*(\w+)/im);
    const textMatch = raw.match(/^TEXT:\s*(.+)/ims);

    const detectedLang = (langMatch?.[1] ?? "english")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
    const transcript = (textMatch?.[1] ?? raw).trim();

    let language: Language = "english";
    if (detectedLang === "pidgin") language = "pidgin";
    else if (detectedLang === "french") language = "french";

    logger.info(
      `[transcribeAudio] lang=${language} | transcript="${transcript.slice(0, 100)}…"`,
    );
    return { transcript, language };
  } catch (err) {
    logger.error(err, "Gemini audio transcription failed");
    throw err;
  }
}

// ─── Translate to Cameroon Pidgin ───
export async function translateToPidgin(text: string): Promise<string> {
  const prompt = `You are a native Cameroon Pidgin English (Kamtok) speaker.

Translate the following text into natural spoken Cameroon Pidgin English (Kamtok) — the kind farmers in Cameroon actually speak.

Rules:
- Use authentic Cameroonian Pidgin vocabulary: "wetin" (what), "dey" (is/are/progressive), "sabi" (know), "chop" (eat), "waka" (go), "abeg" (please), "no wahala" (no problem), "e don" (it has), "make you" (you should), "e be like say" (it seems), "pikin" (small/child), "plenty" (many), "small small" (gradually), "sharp sharp" (quickly), "na" (it is), "dem" (they/them), "di" (the/progressive), "kontri" (country/village), "masa" (sir/boss)
- Keep it SHORT and conversational — like talking to a friend
- Do NOT use formal English
- Return ONLY the Pidgin translation, nothing else

Text:
${text}`;

  const result = await client().models.generateContent({
    model: getTextModel(),
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
  return (result.text ?? "").trim();
}
