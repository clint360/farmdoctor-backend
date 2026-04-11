import { FastifyInstance } from 'fastify';
import { checkHealth } from '../controllers/health.controller';
import { handleTelegramWebhook } from '../controllers/telegram.controller';
import { handleWhatsAppVerify, handleWhatsAppWebhook } from '../controllers/whatsapp.controller';
import { handleExpertApply, handleExpertPaymentStatus, handleGetExperts } from '../controllers/expert.controller';
import { handleGetSubscription, handleCreateSubscription, handlePaymentStatus } from '../controllers/subscription.controller';
import { handleCreateWebCall, handleCallEnded } from '../controllers/retell.controller';
import { handleMissedCall } from '../controllers/missedCall.controller';
/**
 * Setup all application routes
 */
export const setupRoutes = async (fastify: FastifyInstance) => {
  fastify.get('/api/health', checkHealth);

  // Telegram webhook route
  fastify.post('/webhook/telegram', handleTelegramWebhook);

  // WhatsApp webhook routes
  fastify.get('/webhook/whatsapp', handleWhatsAppVerify);
  fastify.post('/webhook/whatsapp', handleWhatsAppWebhook);

  // Expert application & payment
  fastify.post('/api/expert-apply', handleExpertApply);
  fastify.get('/api/expert-apply/status/:transId', handleExpertPaymentStatus);
  fastify.get('/api/experts', handleGetExperts);

  // Subscriptions & Payments
  fastify.get('/api/subscription', handleGetSubscription);
  fastify.post('/api/subscription', handleCreateSubscription);
  fastify.get('/api/subscription/status/:transId', handlePaymentStatus);

  // Retell AI web calls
  fastify.post('/api/retell/create-web-call', handleCreateWebCall);
  fastify.post('/api/retell/call-ended', handleCallEnded);

  //Missed Phone Calls
  fastify.post('/api/missed-call', handleMissedCall);
};
