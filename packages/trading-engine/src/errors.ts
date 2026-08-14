export type DomainErrorCode =
  | 'DUPLICATE_ORDER_CONFLICT'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_CLOSED'
  | 'ENTRY_LIMIT_REACHED'
  | 'FINANCIAL_INVARIANT_VIOLATION'
  | 'INSUFFICIENT_CASH'
  | 'INSUFFICIENT_POSITION'
  | 'INVALID_CONTRIBUTION'
  | 'INVALID_ORDER'
  | 'INVALID_POOL'
  | 'INVALID_TOURNAMENT_TRANSITION'
  | 'STALE_MARKET_PRICE'
  | 'TOURNAMENT_NOT_TRADABLE'
  | 'TOURNAMENT_NOT_FOUND'
  | 'TOURNAMENT_NOT_OPEN'
  | 'UNSUPPORTED_SYMBOL'
  | 'USER_NOT_FOUND';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}
