import type { CandleIntervalDto, MarketSymbolDto } from '@trade-the-pool/shared';

export const queryKeys = {
  session: ['session'] as const,
  devUsers: ['auth', 'dev-users'] as const,
  tournaments: (query = 'pageSize=100') => ['tournaments', query] as const,
  tournament: (identifier: string) => ['tournament', identifier] as const,
  entries: (query = 'pageSize=100') => ['entries', query] as const,
  entry: (entryId: string) => ['entry', entryId] as const,
  positions: (entryId: string) => ['entry', entryId, 'positions'] as const,
  orders: (entryId: string, page = 1) => ['entry', entryId, 'orders', page] as const,
  leaderboard: (tournamentId: string, page = 1) =>
    ['tournament', tournamentId, 'leaderboard', page] as const,
  market: (symbol: MarketSymbolDto) => ['market', symbol] as const,
  candles: (symbol: MarketSymbolDto, interval: CandleIntervalDto) =>
    ['market', symbol, 'candles', interval] as const,
};
