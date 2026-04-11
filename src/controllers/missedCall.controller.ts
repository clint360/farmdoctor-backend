import { FastifyRequest, FastifyReply } from "fastify";
import { processMissedCall } from "../services/missed-call.service";
import { logger } from "../utils/logger";

export const handleMissedCall = async (
    request: FastifyRequest,
    reply: FastifyReply
) => {
    const { phone } = request.body as { phone?: string };

    if (!phone) {
        return reply.status(400).send({ error: "Missing phone number" });
    }

    logger.info(`Missed call webhook received for: ${phone}`);

    const result = await processMissedCall(phone);

    return reply.status(result.success ? 200 : 500).send({
        success: result.success,
        missedCallId: result.missedCallId,
    });
};