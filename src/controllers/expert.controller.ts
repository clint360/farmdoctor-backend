import { FastifyRequest, FastifyReply } from "fastify";
import {
  applyAsExpert,
  checkExpertPaymentAndActivate,
  getExpertsByCity,
  ExpertApplication,
  EXPERT_FEE,
} from "../services/expert.service";
import { logger } from "../utils/logger";

// POST /api/expert-apply — submit application + initiate Fapshi payment
export const handleExpertApply = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as ExpertApplication;

    if (!body.full_name || !body.phone || !body.location || !body.cover_letter || !body.momo_number) {
      return reply.status(400).send({
        success: false,
        message: "Missing required fields: full_name, phone, location, cover_letter, momo_number",
      });
    }

    const medium = body.medium === "orange money" ? "orange money" : "mobile money";

    const result = await applyAsExpert({ ...body, medium });

    if (result.success) {
      return reply.status(201).send(result);
    }
    return reply.status(400).send(result);
  } catch (error) {
    logger.error(error, "Error in expert apply handler");
    return reply.status(500).send({ success: false, message: "Internal server error" });
  }
};

// GET /api/expert-apply/status/:transId — poll Fapshi payment for expert
export const handleExpertPaymentStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const params = request.params as { transId?: string };
    if (!params.transId) {
      return reply.status(400).send({ success: false, message: "transId parameter is required" });
    }

    const result = await checkExpertPaymentAndActivate(params.transId);
    return reply.status(200).send({ success: true, ...result });
  } catch (error) {
    logger.error(error, "Error checking expert payment status");
    return reply.status(500).send({ success: false, message: "Internal server error" });
  }
};

// GET /api/experts?city=...
export const handleGetExperts = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { city?: string };

    if (!query.city) {
      return reply.status(400).send({ success: false, message: "city query parameter is required" });
    }

    const experts = await getExpertsByCity(query.city);
    return reply.status(200).send({ success: true, experts });
  } catch (error) {
    logger.error(error, "Error fetching experts");
    return reply.status(500).send({ success: false, message: "Internal server error" });
  }
};
