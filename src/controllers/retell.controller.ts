import { FastifyRequest, FastifyReply } from "fastify";
import { createWebCall } from "../services/retell.service";
import { logger } from "../utils/logger";

// ─── In-memory rate limit: 1 call per IP per day (no DB) ───
const CALL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const callLog = new Map<string, number>();

function isLocalhost(origin: string | undefined, ip: string | undefined): boolean {
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(origin)) return true;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  return false;
}

function cleanCallLog(): void {
  const now = Date.now();
  for (const [k, ts] of callLog) {
    if (now - ts > CALL_COOLDOWN_MS) callLog.delete(k);
  }
}

export const handleCreateWebCall = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const clientIp = request.ip || "unknown";
    const origin = request.headers.origin;

    // Skip rate limit for localhost/dev
    if (!isLocalhost(origin, clientIp)) {
      if (callLog.size > 5000) cleanCallLog();
      const lastCall = callLog.get(clientIp);
      if (lastCall && Date.now() - lastCall < CALL_COOLDOWN_MS) {
        return reply.status(429).send({
          success: false,
          message: "You can only make 1 call per day. Please try again tomorrow.",
        });
      }
    }

    const result = await createWebCall();

    // Record successful call (skip for localhost)
    if (!isLocalhost(origin, clientIp)) {
      callLog.set(clientIp, Date.now());
    }

    return reply.status(200).send({
      success: true,
      access_token: result.access_token,
      call_id: result.call_id,
    });
  } catch (error: any) {
    logger.error(error, "Error creating Retell web call");
    return reply.status(500).send({
      success: false,
      message: error.message || "Failed to create call session",
    });
  }
};
