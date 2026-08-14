import type {
  ApiEnvelope,
  ApiErrorBody,
  CandleIntervalDto,
  EntryDetailDto,
  EntrySummaryDto,
  FillHistoryDto,
  LeaderboardPageDto,
  MarketCandleDto,
  MarketSnapshotDto,
  MarketSymbolDto,
  OrderHistoryDto,
  OrderRequestDto,
  OrderResultDto,
  PerformanceDto,
  PositionProtectionRequestDto,
  Page,
  PositionDto,
  TournamentDto,
  UserDto,
} from '@trade-the-pool/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiClientError(0, 'BACKEND_UNAVAILABLE', 'The trading service is unavailable.');
  }
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as ApiErrorBody | T | null;
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
    throw new ApiClientError(
      response.status,
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? 'The request could not be completed.',
      error?.requestId,
      error?.details,
    );
  }
  return body as T;
}

export type CreatedEntryDto = {
  id: string;
  sequenceNumber: number;
  tournamentEntryNumber: number;
  entryFee: string;
  prizePoolBeforeEntry: string;
  prizePoolContribution: string;
  platformAllocation: string;
  futureRewardAllocation: string;
  rakebackAmount: string;
  baseBankrollSnapshot: string;
  startingBankroll: string;
  cash: string;
  equity: string;
  currentPrizePool: string;
  newEntryBankroll: string;
  createdAt: string;
};

export const api = {
  async session(): Promise<UserDto | null> {
    try {
      return (await request<ApiEnvelope<{ user: UserDto }>>('/v1/auth/me')).data.user;
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) return null;
      throw error;
    }
  },
  devUsers: () => request<ApiEnvelope<UserDto[]>>('/v1/auth/dev/users'),
  login: (userId: string) =>
    request<ApiEnvelope<{ user: UserDto; expiresInSeconds: number }>>('/v1/auth/dev/login', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  logout: () => request<void>('/v1/auth/logout', { method: 'POST' }),
  tournaments: (query = 'pageSize=100') => request<Page<TournamentDto>>(`/v1/tournaments?${query}`),
  tournament: (identifier: string) =>
    request<ApiEnvelope<TournamentDto>>(`/v1/tournaments/${encodeURIComponent(identifier)}`),
  createEntry: (tournamentId: string) =>
    request<ApiEnvelope<CreatedEntryDto>>(`/v1/tournaments/${tournamentId}/entries`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  entries: (query = 'pageSize=100') => request<Page<EntrySummaryDto>>(`/v1/me/entries?${query}`),
  entry: (entryId: string) => request<ApiEnvelope<EntryDetailDto>>(`/v1/entries/${entryId}`),
  positions: (entryId: string) =>
    request<ApiEnvelope<PositionDto[]>>(`/v1/entries/${entryId}/positions`),
  orders: (entryId: string, page = 1) =>
    request<Page<OrderHistoryDto>>(`/v1/entries/${entryId}/orders?page=${page}&pageSize=100`),
  fills: (entryId: string, page = 1) =>
    request<Page<FillHistoryDto>>(`/v1/entries/${entryId}/fills?page=${page}&pageSize=100`),
  performance: (entryId: string) =>
    request<ApiEnvelope<PerformanceDto>>(`/v1/entries/${entryId}/performance`),
  leaderboard: (tournamentId: string, page = 1) =>
    request<LeaderboardPageDto>(
      `/v1/tournaments/${tournamentId}/leaderboard?page=${page}&pageSize=50`,
    ),
  market: (symbol: MarketSymbolDto) =>
    request<ApiEnvelope<MarketSnapshotDto>>(`/v1/markets/${symbol}`),
  candles: (symbol: MarketSymbolDto, interval: CandleIntervalDto, limit = 240) =>
    request<ApiEnvelope<MarketCandleDto[]>>(
      `/v1/markets/${symbol}/candles?interval=${interval}&limit=${limit}`,
    ),
  order: (body: OrderRequestDto, idempotencyKey: string) =>
    request<ApiEnvelope<OrderResultDto>>('/v1/orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    }),
  cancelOrder: (entryId: string, orderId: string) =>
    request<ApiEnvelope<{ id: string; status: 'CANCELLED' }>>(
      `/v1/entries/${entryId}/orders/${orderId}`,
      { method: 'DELETE' },
    ),
  setProtection: (
    entryId: string,
    symbol: MarketSymbolDto,
    body: PositionProtectionRequestDto,
    idempotencyKey: string,
  ) =>
    request<
      ApiEnvelope<
        Array<{
          id: string;
          type: 'TAKE_PROFIT' | 'STOP_LOSS';
          triggerPrice: string;
          status: 'OPEN';
        }>
      >
    >(`/v1/entries/${entryId}/positions/${symbol}/protection`, {
      method: 'PUT',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    }),
  advanceMarket: (symbol: MarketSymbolDto, price: string) =>
    request<ApiEnvelope<MarketSnapshotDto>>('/v1/dev/market/advance', {
      method: 'POST',
      body: JSON.stringify({ symbol, price }),
    }),
};
