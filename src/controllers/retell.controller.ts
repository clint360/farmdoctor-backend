import { FastifyRequest, FastifyReply } from "fastify";
import { createWebCall } from "../services/retell.service";
import { logger } from "../utils/logger";

export const handleCreateWebCall = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const result = await createWebCall();
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
