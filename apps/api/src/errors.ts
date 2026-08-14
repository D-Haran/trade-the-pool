import { DomainError, type DomainErrorCode } from '@trade-the-pool/trading-engine';

export type ApiErrorCode =
  | DomainErrorCode
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHORIZATION_DENIED'
  | 'DEVELOPMENT_AUTH_DISABLED'
  | 'INTERNAL_ERROR'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'RATE_LIMITED';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const domainStatuses: Record<DomainErrorCode, number> = {
  DUPLICATE_ORDER_CONFLICT: 409,
  ENTRY_NOT_FOUND: 404,
  ENTRY_CLOSED: 409,
  ENTRY_LIMIT_REACHED: 409,
  FINANCIAL_INVARIANT_VIOLATION: 500,
  INSUFFICIENT_CASH: 422,
  INSUFFICIENT_POSITION: 422,
  INVALID_CONTRIBUTION: 422,
  INVALID_ORDER: 400,
  INVALID_POOL: 422,
  INVALID_TOURNAMENT_TRANSITION: 409,
  STALE_MARKET_PRICE: 503,
  TOURNAMENT_NOT_TRADABLE: 409,
  TOURNAMENT_NOT_FOUND: 404,
  TOURNAMENT_NOT_OPEN: 409,
  UNSUPPORTED_SYMBOL: 400,
  USER_NOT_FOUND: 404,
};

export function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DomainError) {
    if (error.code === 'FINANCIAL_INVARIANT_VIOLATION')
      return new ApiError(
        500,
        'FINANCIAL_INVARIANT_VIOLATION',
        'Financial state could not be verified.',
      );
    return new ApiError(domainStatuses[error.code], error.code, error.message, error.details);
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    if (error.statusCode === 404)
      return new ApiError(404, 'NOT_FOUND', 'The requested resource does not exist.');
    return new ApiError(error.statusCode, 'INVALID_REQUEST', 'Request validation failed.');
  }
  return new ApiError(500, 'INTERNAL_ERROR', 'An unexpected internal error occurred.');
}
