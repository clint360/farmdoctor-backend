import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import { logger } from './utils/logger';
import { setupPlugins } from './plugins';
import { setupRoutes } from './routes';

export const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: logger as any,
  });

  // Global Error Handler Middleware
  app.setErrorHandler((error, request, reply) => {
    app.log.error(error);
    reply.status(error.statusCode || 500).send({
      success: false,
      message: error.message || 'Internal Server Error',
    });
  });

  // Not Found Handler
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      success: false,
      message: `Route ${request.method}:${request.url} not found`,
    });
  });

  // Register plugins
  await app.register(setupPlugins);

  // Register routes
  await app.register(setupRoutes);

  return app;
};
