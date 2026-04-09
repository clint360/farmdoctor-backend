import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import { FastifyInstance } from 'fastify';

/**
 * Global plugins registration
 */
export const setupPlugins = fp(async (fastify: FastifyInstance) => {
  // We can register ecosystem plugins here like @fastify/helmet, @fastify/cors, etc.
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  fastify.log.info('Plugins initialized');
});
