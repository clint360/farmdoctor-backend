import { FastifyRequest, FastifyReply } from "fastify";
import { searchInsights, getInsightsSuggestions } from "../services/insights.service";
import { logger } from "../utils/logger";

// ─── IP-based rate limiter (in-memory, no DB) ────────────────────────────────
// Limit: 4 insights searches per IP per day. Resets automatically every 24h.
const DAILY_LIMIT = 4;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type UsageEntry = { count: number; resetAt: number };
const ipUsage = new Map<string, UsageEntry>();

// Cleanup stale entries every hour to prevent memory leaks on long-running server
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipUsage.entries()) {
    if (now >= entry.resetAt) ipUsage.delete(ip);
  }
}, 60 * 60 * 1000);

function getClientIp(request: FastifyRequest): string {
  // Respect X-Forwarded-For for proxied deployments (ngrok, Render, Vercel)
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0].trim();
  return request.ip ?? "unknown";
}

function checkRateLimit(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = ipUsage.get(ip);

  if (!entry || now >= entry.resetAt) {
    // New window
    ipUsage.set(ip, { count: 1, resetAt: now + MS_PER_DAY });
    return { allowed: true, remaining: DAILY_LIMIT - 1 };
  }

  if (entry.count >= DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  entry.count += 1;
  return { allowed: true, remaining: DAILY_LIMIT - entry.count };
}

// ─── GET /api/insights/search ────────────────────────────────────────────────
export const handleInsightsSearch = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const query = request.query as {
    crop?: string;
    location?: string;
    locale?: string;
  };

  const crop = query.crop?.trim();
  if (!crop) {
    return reply.status(400).send({
      success: false,
      message: "crop query parameter is required",
    });
  }

  // Rate limit check
  const ip = getClientIp(request);
  const { allowed, remaining } = checkRateLimit(ip);

  if (!allowed) {
    return reply.status(429).send({
      success: false,
      message: "Daily insights search limit reached. Try again tomorrow.",
    });
  }

  // Add remaining-searches header for frontend awareness
  reply.header("X-Insights-Remaining", String(remaining));

  try {
    const insights = await searchInsights(
      crop,
      query.location?.trim() || undefined,
      query.locale?.trim() || undefined
    );

    if (!insights.isValidCrop) {
      return reply.status(422).send({
        success: false,
        notACrop: true,
        message: insights.adviceSummary || `"${crop}" does not appear to be a crop or agricultural topic.`,
      });
    }

    return reply.status(200).send({ success: true, data: insights });
  } catch (error) {
    logger.error(error, "[insights] handleInsightsSearch error");
    return reply.status(500).send({
      success: false,
      message: "Failed to generate insights. Please try again.",
    });
  }
};

// ─── GET /api/insights/suggestions ───────────────────────────────────────────
export const handleInsightsSuggestions = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const query = request.query as { q?: string };
  const q = (query.q ?? "").trim();

  try {
    const result = await getInsightsSuggestions(q);
    return reply.status(200).send(result);
  } catch (error) {
    logger.error(error, "[insights] handleInsightsSuggestions error");
    return reply.status(500).send({ suggestions: [] });
  }
};
