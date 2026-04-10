import { FastifyRequest, FastifyReply } from "fastify";
import {
  getSubscription,
  initiateSubscriptionPayment,
  checkPaymentAndActivate,
  VALID_PLANS,
  PLAN_PRICES,
  PLAN_LIMITS,
  PlanName,
} from "../services/subscription.service";
import { logger } from "../utils/logger";

// GET /api/subscription?phone=237...
export const handleGetSubscription = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { phone?: string };
    if (!query.phone) {
      return reply.status(400).send({ success: false, message: "phone query parameter is required" });
    }

    const subscription = await getSubscription(query.phone);
    const isActive =
      subscription?.status === "active" &&
      new Date(subscription.expires_at) > new Date();

    return reply.status(200).send({
      success: true,
      subscription: subscription || null,
      plan: isActive ? subscription!.plan : "free",
      isActive,
      plans: VALID_PLANS.map((p) => ({
        name: p,
        price: PLAN_PRICES[p],
        limits: PLAN_LIMITS[p],
      })),
    });
  } catch (error) {
    logger.error(error, "Error fetching subscription");
    return reply.status(500).send({ success: false, message: "Internal server error" });
  }
};

// POST /api/subscription — initiate Fapshi payment
export const handleCreateSubscription = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as {
      phone: string;
      plan: string;
      momo_number: string;
      medium: string;
    };

    if (!body.phone || !body.plan || !body.momo_number) {
      return reply.status(400).send({
        success: false,
        message: "Missing required fields: phone, plan, momo_number",
      });
    }

    if (!VALID_PLANS.includes(body.plan as PlanName)) {
      return reply.status(400).send({
        success: false,
        message: `Invalid plan. Must be one of: ${VALID_PLANS.join(", ")}`,
      });
    }

    const medium = body.medium === "orange money" ? "orange money" : "mobile money";

    const result = await initiateSubscriptionPayment({
      phone: body.phone,
      plan: body.plan as PlanName,
      momo_number: body.momo_number,
      medium,
    });

    if (result.success) {
      return reply.status(201).send(result);
    }
    return reply.status(400).send(result);
  } catch (error) {
    logger.error(error, "Error creating subscription");
    return reply.status(500).send({ success: false, message: "Internal server error" });
  }
};

// GET /api/subscription/status/:transId — poll Fapshi payment status
export const handlePaymentStatus = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const params = request.params as { transId?: string };
    if (!params.transId) {
      return reply.status(400).send({ success: false, message: "transId parameter is required" });
    }

    const result = await checkPaymentAndActivate(params.transId);
    return reply.status(200).send({ success: true, ...result });
  } catch (error) {
    logger.error(error, "Error checking payment status");
    return reply.status(500).send({ success: false, message: "Internal server error" });
  }
};
