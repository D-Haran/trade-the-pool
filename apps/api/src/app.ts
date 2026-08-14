import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    genReqId: (request) => request.headers['x-request-id']?.toString() ?? randomUUID(),
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400
        ? error.statusCode
        : 500;
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    request.log.error(
      { err: error instanceof Error ? error : new Error(message) },
      'request failed',
    );
    return reply.status(statusCode).send({
      error: statusCode === 500 ? 'Internal Server Error' : message,
      requestId: request.id,
    });
  });

  app.get('/health', async (request) => ({ status: 'ok', requestId: request.id }));
  return app;
}
