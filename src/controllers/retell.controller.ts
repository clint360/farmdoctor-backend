import { FastifyRequest, FastifyReply } from "fastify";
import { createWebCall } from "../services/retell.service";
import { logger } from "../utils/logger";

// ─── In-memory rate limit: 3 min (180s) of call time per IP per day ───
const MAX_DAILY_SECONDS = 3 * 60; // 180s

interface UsageEntry { date: string; usedSeconds: number }
const usageLog = new Map<string, UsageEntry>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function getUsage(ip: string): UsageEntry {
  const entry = usageLog.get(ip);
  const today = todayKey();
  if (!entry || entry.date !== today) return { date: today, usedSeconds: 0 };
  return entry;
}

function isLocalhost(origin: string | undefined, ip: string | undefined): boolean {
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(origin)) return true;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  return false;
}

function cleanUsageLog(): void {
  const today = todayKey();
  for (const [k, v] of usageLog) {
    if (v.date !== today) usageLog.delete(k);
  }
}

export const handleCreateWebCall = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const clientIp = request.ip || "unknown";
    const origin = request.headers.origin;
    const isDev = isLocalhost(origin, clientIp);

    if (!isDev) {
      if (usageLog.size > 5000) cleanUsageLog();
      const usage = getUsage(clientIp);
      const remaining = MAX_DAILY_SECONDS - usage.usedSeconds;
      if (remaining <= 0) {
        return reply.status(429).send({
          success: false,
          remaining_seconds: 0,
          message: "You've used your 3 free minutes for today. Please try again tomorrow.",
        });
      }
    }

    const result = await createWebCall();

    const usage = getUsage(clientIp);
    const remaining = isDev ? MAX_DAILY_SECONDS : MAX_DAILY_SECONDS - usage.usedSeconds;

    return reply.status(200).send({
      success: true,
      access_token: result.access_token,
      call_id: result.call_id,
      remaining_seconds: remaining,
    });
  } catch (error: any) {
    logger.error(error, "Error creating Retell web call");
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to create call session",
    });
  }
};

// ─── Report call duration when call ends ───
export const handleCallEnded = async (
  request: FastifyRequest<{ Body: { duration: number } }>,
  reply: FastifyReply,
) => {
  const clientIp = request.ip || "unknown";
  const origin = request.headers.origin;

  if (isLocalhost(origin, clientIp)) {
    return reply.send({ success: true, remaining_seconds: MAX_DAILY_SECONDS });
  }

  const duration = Math.max(0, Math.ceil(request.body?.duration || 0));
  const usage = getUsage(clientIp);
  usage.usedSeconds += duration;
  usageLog.set(clientIp, usage);

  const remaining = Math.max(0, MAX_DAILY_SECONDS - usage.usedSeconds);
  logger.info({ ip: clientIp, duration, totalUsed: usage.usedSeconds, remaining }, "Call ended, usage updated");

  return reply.send({ success: true, remaining_seconds: remaining });
};
