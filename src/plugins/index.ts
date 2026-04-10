import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import { FastifyInstance } from 'fastify';

/**
 * Global plugins registration
 */
export const setupPlugins = fp(async (fastify: FastifyInstance) => {
  // CORS: allow the website (dev + production) and the admin dashboard
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'https://farm-doctor.vercel.app',
    'https://farmdoctor-admin.vercel.app',
  ];

  await fastify.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (mobile apps, curl, webhooks)
      if (!origin) return cb(null, true);
      if (allowedOrigins.some((o) => origin.startsWith(o))) return cb(null, true);
      // Also allow any *.vercel.app preview deploys and ngrok
      if (/\.(vercel\.app|ngrok-free\.dev|ngrok\.io)$/.test(new URL(origin).hostname)) {
        return cb(null, true);
      }
      cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  fastify.log.info('Plugins initialized');
});
