import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function parseAllowedOrigins(value: string): string[] {
  const origins = value.split(',').map((origin) => origin.trim());
  if (!origins.length || origins.some((origin) => !origin || origin === '*'))
    throw new Error('Credentialed CORS requires explicit origins.');
  return origins;
}

function requestSourceOrigin(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (origin) return origin;
  const referer = request.headers.referer;
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return 'invalid';
  }
}

export function assertAllowedBrowserOrigin(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
): void {
  const source = requestSourceOrigin(request);
  const fetchSite = request.headers['sec-fetch-site'];
  if ((source && !allowedOrigins.includes(source)) || fetchSite === 'cross-site')
    throw new ApiError(403, 'CSRF_VALIDATION_FAILED', 'The request origin is not allowed.');
}

export function enforceCsrf(request: FastifyRequest, allowedOrigins: readonly string[]): void {
  if (!request.url.startsWith('/v1/') || !unsafeMethods.has(request.method)) return;
  assertAllowedBrowserOrigin(request, allowedOrigins);
}
