import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';

/**
 * Global plugins registration
 */
export const setupPlugins = fp(async (fastify: FastifyInstance) => {
  // We can register ecosystem plugins here like @fastify/helmet, @fastify/cors, etc.
  fastify.log.info('Plugins initialized');
});
