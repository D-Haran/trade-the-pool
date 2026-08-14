import { DomainError, type DomainErrorCode } from '@trade-the-pool/trading-engine';

export type ApiErrorCode =
  | DomainErrorCode
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHENTICATION_UNAVAILABLE'
  | 'AUTHORIZATION_DENIED'
  | 'CSRF_VALIDATION_FAILED'
  | 'DEVELOPMENT_AUTH_DISABLED'
  | 'INTERNAL_ERROR'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'INVALID_REQUEST'
  | 'MARKET_DATA_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'WALLET_ALREADY_LINKED'
  | 'WALLET_AUTH_DISABLED'
  | 'WALLET_AUTHENTICATION_UNAVAILABLE'
  | 'WALLET_CHALLENGE_EXPIRED'
  | 'WALLET_CHALLENGE_INVALID'
  | 'WALLET_LAST_AUTH_METHOD'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_OWNED_BY_ANOTHER_USER'
  | 'WALLET_SIGNATURE_INVALID';

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
  INVALID_FEE_TIERS: 500,
  INVALID_ORDER: 400,
  INVALID_PAYOUT_CONFIG: 500,
  INVALID_POOL: 422,
  ORDER_NOT_CANCELLABLE: 409,
  ORDER_NOT_FOUND: 404,
  POSITION_SIDE_CONFLICT: 409,
  INVALID_RAKEBACK_CONFIG: 500,
  INVALID_TOURNAMENT_SCHEDULE: 500,
  INVALID_TOURNAMENT_TRANSITION: 409,
  STALE_MARKET_PRICE: 503,
  TOURNAMENT_NOT_TRADABLE: 409,
  TOURNAMENT_NOT_FOUND: 404,
  TOURNAMENT_NOT_OPEN: 409,
  TRADING_NOT_STARTED: 409,
  REGISTRATION_NOT_OPEN: 409,
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
