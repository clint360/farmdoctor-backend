import { FastifyRequest, FastifyReply } from 'fastify';
import { getHealthStatus } from '../services/health.service';

export const checkHealth = async (request: FastifyRequest, reply: FastifyReply) => {
  const status = getHealthStatus();
  return reply.status(200).send(status);
};
