import OpenAI from "openai";
import { logger } from "../../utils/logger";

/**
 * Single entry point for every LLM call in the backend (Telegram, WhatsApp,
 * insights, web). Talks to OpenRouter through the OpenAI-compatible API.
 *
 * Concurrency: the client is stateless (no per-conversation state is kept
 * here), calls are capped by a small semaphore so a burst of messages cannot
 * trip provider rate limits, and 429/5xx responses are retried with jittered
 * exponential backoff. OpenRouter-side model fallbacks cover provider outages.
 */

// ─── Models (cheap by default, all overridable via env) ─────────────────
// Prices are per 1M tokens (input / output) on OpenRouter.
const DEFAULTS = {
  // google/gemini-2.5-flash-lite: $0.10 / $0.40, text + image + audio
  primary: "google/gemini-2.5-flash-lite",
  // mistral-small-3.2-24b: $0.075 / $0.20, text + image
  fallbackText: "mistralai/mistral-small-3.2-24b-instruct",
  // voxtral-small-24b: $0.10, audio input
  fallbackAudio: "mistralai/voxtral-small-24b-2507",
};

export type AiTask = "text" | "vision" | "audio";

const csv = (v: string | undefined): string[] =>
  (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function modelsFor(task: AiTask): string[] {
  const env = process.env;
  switch (task) {
    case "vision":
      return [
        env.OPENROUTER_VISION_MODEL || env.OPENROUTER_MODEL || DEFAULTS.primary,
        ...(csv(env.OPENROUTER_VISION_FALLBACKS).length
          ? csv(env.OPENROUTER_VISION_FALLBACKS)
          : [DEFAULTS.fallbackText]),
      ];
    case "audio":
      return [
        env.OPENROUTER_AUDIO_MODEL || env.OPENROUTER_MODEL || DEFAULTS.primary,
        ...(csv(env.OPENROUTER_AUDIO_FALLBACKS).length
          ? csv(env.OPENROUTER_AUDIO_FALLBACKS)
          : [DEFAULTS.fallbackAudio]),
      ];
    default:
      return [
        env.OPENROUTER_TEXT_MODEL || env.OPENROUTER_MODEL || DEFAULTS.primary,
        ...(csv(env.OPENROUTER_TEXT_FALLBACKS).length
          ? csv(env.OPENROUTER_TEXT_FALLBACKS)
          : [DEFAULTS.fallbackText]),
      ];
  }
}

// ─── Client ─────────────────────────────────────────────────────────────
let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
    _client = new OpenAI({
      apiKey,
      baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      timeout: Number(process.env.OPENROUTER_TIMEOUT_MS) || 60_000,
      maxRetries: 0, // retries handled below
      defaultHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://farm-doctor.com",
        "X-Title": process.env.OPENROUTER_APP_NAME || "Farm Doctor",
      },
    });
  }
  return _client;
}

// ─── Concurrency limiter ────────────────────────────────────────────────
const MAX_CONCURRENCY = Math.max(
  1,
  Number(process.env.OPENROUTER_MAX_CONCURRENCY) || 8,
);
let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else active--;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Public API ─────────────────────────────────────────────────────────
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; base64: string; mimeType: string }
  | { type: "audio"; base64: string; format: "wav" | "mp3" };

export type CompleteOptions = {
  task?: AiTask;
  /** Sent as a real `system` message so it is identical across requests. */
  system?: string;
  user: string | ContentPart[];
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
};

function toApiContent(user: string | ContentPart[]): any {
  if (typeof user === "string") return user;
  return user.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image") {
      return {
        type: "image_url",
        image_url: { url: `data:${p.mimeType};base64,${p.base64}` },
      };
    }
    return { type: "input_audio", input_audio: { data: p.base64, format: p.format } };
  });
}

export async function complete(opts: CompleteOptions): Promise<string> {
  const task: AiTask =
    opts.task ??
    (Array.isArray(opts.user) && opts.user.some((p) => p.type === "image")
      ? "vision"
      : Array.isArray(opts.user) && opts.user.some((p) => p.type === "audio")
        ? "audio"
        : "text");
  const [model, ...fallbacks] = modelsFor(task);

  const messages: any[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: toApiContent(opts.user) });

  const body: any = {
    model,
    messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 1024,
    // OpenRouter extension: automatic provider/model fallback chain
    ...(fallbacks.length ? { models: [model, ...fallbacks] } : {}),
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const maxAttempts = 3;
  await acquire();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await client().chat.completions.create(body);
        const text = res.choices?.[0]?.message?.content;
        const out = typeof text === "string" ? text.trim() : "";
        if (!out) throw Object.assign(new Error("OpenRouter returned an empty response"), { status: 502 });
        return out;
      } catch (err: any) {
        const status: number | undefined = err?.status;
        const retryable = !status || status === 429 || status >= 500;
        if (!retryable || attempt >= maxAttempts) {
          logger.error(
            { status, message: err?.message, model, task },
            "OpenRouter request failed",
          );
          throw err;
        }
        const retryAfter = Number(err?.headers?.["retry-after"]);
        const delay =
          (Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 500 * 2 ** (attempt - 1)) + Math.random() * 250;
        logger.warn({ status, attempt, delay: Math.round(delay) }, "OpenRouter retrying");
        await sleep(delay);
      }
    }
  } finally {
    release();
  }
}

/** Strip ``` fences models sometimes add around JSON. */
export function stripFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

/** complete() + tolerant JSON parse. Throws if the output is not JSON. */
export async function completeJson<T>(opts: Omit<CompleteOptions, "json">): Promise<T> {
  const raw = await complete({ ...opts, json: true });
  return JSON.parse(stripFences(raw)) as T;
}
