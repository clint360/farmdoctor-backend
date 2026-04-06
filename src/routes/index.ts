import { FastifyInstance } from 'fastify';
import { checkHealth } from '../controllers/health.controller';
import { handleTelegramWebhook } from '../controllers/telegram.controller';

/**
 * Setup all application routes
 */
export const setupRoutes = async (fastify: FastifyInstance) => {
  fastify.get('/api/health', checkHealth);

  // Telegram webhook route
  fastify.post('/webhook/telegram', handleTelegramWebhook);
};
