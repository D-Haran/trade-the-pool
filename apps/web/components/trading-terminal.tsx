'use client';

import { SUPPORTED_MARKET_SYMBOLS } from '@trade-the-pool/shared';
import type {
  ApiEnvelope,
  EntryDetailDto,
  MarketSnapshotDto,
  MarketSymbolDto,
  OrderHistoryDto,
  ProfessionalOrderRequestDto,
  RealtimeEvent,
  TournamentDto,
} from '@trade-the-pool/shared';
import { AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiClientError } from '@/lib/api-client';
import { formatPrice, formatQuantity, formatUsd } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { isTradable } from '@/lib/tournaments';
import { cn } from '@/lib/cn';
import { useTerminalStore } from '@/lib/terminal-store';
import { useRealtime } from '@/hooks/use-realtime';
import { AuthGuard } from './auth-guard';
import { ErrorState, LoadingState } from './ui/states';
import { useToast } from './ui/toast';
import { ChartWorkspace } from './terminal/chart-workspace';
import { MarketHeader } from './terminal/market-header';
import { MarketActivityStrip } from './terminal/market-activity-strip';
import { MarketDepthPanel } from './terminal/market-depth';
import { OrderTicket } from './terminal/order-ticket';
import { TerminalPanels } from './terminal/terminal-panels';
import { AccountStrip, TournamentStatus } from './terminal/tournament-status';

const symbols: MarketSymbolDto[] = [...SUPPORTED_MARKET_SYMBOLS];

function orderError(error: unknown): string {
  if (!(error instanceof ApiClientError)) return 'The order could not be completed.';
  const messages: Record<string, string> = {
    INSUFFICIENT_CASH: 'Insufficient simulated cash for this order and fee.',
    INSUFFICIENT_MARGIN: 'Insufficient simulated margin or gross exposure capacity.',
    INSUFFICIENT_POSITION: 'The position no longer has enough quantity for this close.',
    POSITION_SIDE_CONFLICT: 'Close the existing position before opening the opposite side.',
    POSITION_LEVERAGE_CONFLICT: 'Close the position before changing leverage for this market.',
    ENTRY_BUSTED: 'This tournament entry is busted and can no longer open positions.',
    STALE_MARKET_PRICE: 'Market data is stale. Trading is temporarily disabled.',
    TOURNAMENT_NOT_TRADABLE: 'Tournament trading has closed.',
    TRADING_NOT_STARTED: 'Tournament trading has not started.',
    INVALID_ORDER: 'Review the order size and price levels.',
    DUPLICATE_ORDER_CONFLICT: 'This order key was already used for a different request.',
    ORDER_NOT_CANCELLABLE: 'The order filled or was cancelled before this request arrived.',
    RATE_LIMITED: 'Order submission is temporarily rate limited.',
  };
  return messages[error.code] ?? error.message;
}

function useClock(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function Terminal({ slug, entryId }: { slug: string; entryId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const now = useClock();
  const { symbol, setSymbol, confirmationsEnabled } = useTerminalStore();
  const [switching, setSwitching] = useState(false);
  const [depthCollapsed, setDepthCollapsed] = useState(false);
  const retryRef = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => setSwitching(false), [entryId]);
  useEffect(() => {
    const selected = new URLSearchParams(window.location.search).get('symbol');
    if (symbols.includes(selected as MarketSymbolDto)) setSymbol(selected as MarketSymbolDto);
  }, [setSymbol]);

  const entry = useQuery({
    queryKey: queryKeys.entry(entryId),
    queryFn: () => api.entry(entryId),
    retry: false,
  });
  const confirmed = entry.data?.data.id === entryId;
  const tournamentId = entry.data?.data.tournament.id;
  const entriesQuery = `pageSize=100${tournamentId ? `&tournamentId=${tournamentId}` : ''}`;
  const tournament = useQuery({
    queryKey: queryKeys.tournament(slug),
    queryFn: () => api.tournament(slug),
  });
  const entries = useQuery({
    queryKey: queryKeys.entries(entriesQuery),
    queryFn: () => api.entries(entriesQuery),
    enabled: Boolean(tournamentId),
    retry: false,
  });
  const markets = useQuery({
    queryKey: queryKeys.markets,
    queryFn: () => api.markets(),
    refetchInterval: 15_000,
  });
  const positions = useQuery({
    queryKey: queryKeys.positions(entryId),
    queryFn: () => api.positions(entryId),
    enabled: confirmed,
    retry: false,
  });
  const orders = useQuery({
    queryKey: queryKeys.orders(entryId),
    queryFn: () => api.orders(entryId),
    enabled: confirmed,
    retry: false,
  });
  const fills = useQuery({
    queryKey: queryKeys.fills(entryId),
    queryFn: () => api.fills(entryId),
    enabled: confirmed,
    retry: false,
  });
  const performance = useQuery({
    queryKey: queryKeys.performance(entryId),
    queryFn: () => api.performance(entryId),
    enabled: confirmed,
    retry: false,
  });
  const leaderboard = useQuery({
    queryKey: queryKeys.leaderboard(tournamentId ?? 'pending'),
    queryFn: () => api.leaderboard(tournamentId!),
    enabled: Boolean(tournamentId),
  });

  const marketMap = useMemo(
    () =>
      Object.fromEntries(
        (markets.data?.data ?? []).map((market) => [market.symbol, market] as const),
      ) as Partial<Record<MarketSymbolDto, MarketSnapshotDto>>,
    [markets.data?.data],
  );
  const activeMarket = marketMap[symbol];

  const invalidateTradingState = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.entry(entryId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.positions(entryId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.orders(entryId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.fills(entryId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.performance(entryId) }),
      queryClient.invalidateQueries({ queryKey: ['entries'] }),
      tournamentId
        ? queryClient.invalidateQueries({ queryKey: queryKeys.leaderboard(tournamentId) })
        : Promise.resolve(),
    ]);

  const handleEvent = (event: RealtimeEvent) => {
    if (event.type === 'market.price')
      queryClient.setQueryData<ApiEnvelope<MarketSnapshotDto[]>>(queryKeys.markets, (current) =>
        current
          ? {
              data: current.data.map((market) =>
                market.symbol === event.symbol
                  ? {
                      ...market,
                      price: event.price,
                      markPrice: event.markPrice,
                      marketTimestamp: event.marketTimestamp,
                      markTimestamp: event.markTimestamp,
                      source: event.source,
                      markSource: event.markSource,
                      status: event.status,
                      exchangeStatus: event.exchangeStatus,
                    }
                  : market,
              ),
            }
          : current,
      );
    if (event.type === 'market.status')
      queryClient.setQueryData<ApiEnvelope<MarketSnapshotDto[]>>(queryKeys.markets, (current) =>
        current
          ? {
              data: current.data.map((market) =>
                market.symbol === event.symbol ? { ...market, status: event.status } : market,
              ),
            }
          : current,
      );
    if (event.type === 'entry.account_updated' && event.entryId === entryId) {
      queryClient.setQueryData<ApiEnvelope<EntryDetailDto>>(queryKeys.entry(entryId), (current) =>
        current
          ? {
              data: {
                ...current.data,
                cash: event.cash,
                realizedPnL: event.realizedPnL,
                unrealizedPnL: event.unrealizedPnL,
                equity: event.equity,
                score: event.score,
              },
            }
          : current,
      );
      void invalidateTradingState();
    }
    if (event.type === 'tournament.prize_pool_updated')
      queryClient.setQueryData<ApiEnvelope<TournamentDto>>(queryKeys.tournament(slug), (current) =>
        current
          ? {
              data: {
                ...current.data,
                currentPrizePool: event.currentPrizePool,
                newEntryBankroll: event.newEntryBankroll,
                totalEntries: event.totalEntries,
              },
            }
          : current,
      );
    if (event.type === 'leaderboard.updated' && tournamentId)
      void queryClient.invalidateQueries({ queryKey: queryKeys.leaderboard(tournamentId) });
    if (event.type === 'tournament.status_changed')
      void queryClient.invalidateQueries({ queryKey: queryKeys.tournament(slug) });
  };

  const topics = useMemo(
    () =>
      confirmed && tournamentId
        ? [`market:${symbol}`, `tournament:${tournamentId}`, `entry:${entryId}`]
        : [],
    [confirmed, entryId, symbol, tournamentId],
  );
  const connection = useRealtime(topics, handleEvent, () => {
    void invalidateTradingState();
    void queryClient.invalidateQueries({ queryKey: queryKeys.markets });
    void queryClient.invalidateQueries({ queryKey: queryKeys.book(symbol) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.marketTrades(symbol) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.tournament(slug) });
  });

  const submit = useMutation({
    mutationFn: ({ body, key }: { body: ProfessionalOrderRequestDto; key: string }) =>
      api.order(body, key),
    onSuccess: async ({ data }) => {
      retryRef.current = null;
      if (data.status === 'OPEN')
        toast.push({
          tone: 'success',
          title: `${data.positionSide} ${data.symbol.replace('-', '/')} order open`,
          detail: `${data.orderType.replace('_', ' ')} · ${data.requestedNotional ? formatUsd(data.requestedNotional) : 'close order'}`,
        });
      else
        toast.push({
          tone: 'success',
          title: `${data.positionSide} ${data.symbol.split('-')[0]} FILLED`,
          detail: `${data.quantity ? formatQuantity(data.quantity) : '—'} @ ${data.fillPrice ? formatPrice(data.fillPrice) : '—'} · Fee ${data.fee ? formatUsd(data.fee) : '—'}`,
        });
      await invalidateTradingState();
    },
    onError: (error) => {
      if (!(error instanceof ApiClientError) || error.status !== 0) retryRef.current = null;
      toast.push({ tone: 'error', title: 'Order rejected', detail: orderError(error) });
    },
  });

  const sendOrder = (body: ProfessionalOrderRequestDto) => {
    const fingerprint = JSON.stringify(body);
    const pending =
      retryRef.current?.fingerprint === fingerprint
        ? retryRef.current
        : { fingerprint, key: crypto.randomUUID() };
    retryRef.current = pending;
    submit.mutate({ body, key: pending.key });
  };

  const cancel = useMutation({
    mutationFn: (order: OrderHistoryDto) => api.cancelOrder(entryId, order.id),
    onSuccess: async () => {
      toast.push({
        tone: 'success',
        title: 'Order cancelled',
        detail: 'The server confirmed cancellation.',
      });
      await invalidateTradingState();
    },
    onError: (error) =>
      toast.push({ tone: 'error', title: 'Cancellation failed', detail: orderError(error) }),
  });

  const protect = useMutation({
    mutationFn: ({
      position,
      takeProfit,
      stopLoss,
    }: {
      position: NonNullable<typeof positions.data>['data'][number];
      takeProfit: string | null;
      stopLoss: string | null;
    }) =>
      api.setProtection(
        entryId,
        position.symbol,
        { takeProfitPrice: takeProfit, stopLossPrice: stopLoss },
        crypto.randomUUID(),
      ),
    onSuccess: async () => {
      toast.push({
        tone: 'success',
        title: 'Protection updated',
        detail: 'TP/SL levels are server-authoritative.',
      });
      await invalidateTradingState();
    },
    onError: (error) =>
      toast.push({ tone: 'error', title: 'Protection rejected', detail: orderError(error) }),
  });

  if (entry.isLoading) return <LoadingState label="Loading trading account" />;
  if (entry.isError || !entry.data) {
    const denied = entry.error instanceof ApiClientError && entry.error.status === 403;
    return (
      <div className="terminal-failure">
        <ErrorState
          title={denied ? 'Private entry unavailable' : 'Trading account unavailable'}
          detail={
            denied
              ? 'This entry belongs to another user.'
              : 'The trading account could not be loaded.'
          }
          retry={denied ? undefined : () => entry.refetch()}
        />
      </div>
    );
  }

  const account = entry.data.data;
  const marketError = markets.isError;
  const stale =
    !activeMarket ||
    ['STALE', 'RECONNECTING', 'UNAVAILABLE', 'DEGRADED'].includes(activeMarket.status);
  const freshness = marketError
    ? 'UNAVAILABLE'
    : connection === 'RECONNECTING' || connection === 'CONNECTING'
      ? 'RECONNECTING'
      : (activeMarket?.status ?? 'UNAVAILABLE');
  const deadlinePassed = now >= new Date(account.tournament.tradingClosesAt).getTime();
  const restUnavailable = entry.isError || tournament.isError || marketError;
  const tradeDisabled =
    !confirmed ||
    switching ||
    restUnavailable ||
    stale ||
    connection !== 'CONNECTED' ||
    deadlinePassed ||
    account.isBusted ||
    !tournament.data ||
    !isTradable(tournament.data.data.status);
  const disabledReason = restUnavailable
    ? 'Trading service unavailable.'
    : account.isBusted
      ? 'ENTRY BUSTED. Trading is disabled; history and final standing remain available.'
      : stale
        ? activeMarket?.status === 'DEGRADED'
          ? 'Authoritative pricing disagrees with healthy comparison feeds. New orders are paused.'
          : 'Authoritative market data is stale. Waiting for a trusted update.'
        : connection !== 'CONNECTED'
          ? 'Realtime state is reconnecting. Orders are paused for safety.'
          : deadlinePassed || (tournament.data && !isTradable(tournament.data.data.status))
            ? 'Tournament trading has closed.'
            : switching
              ? 'Switching active entry…'
              : null;

  const selectMarket = (next: MarketSymbolDto) => {
    setSymbol(next);
    const url = new URL(window.location.href);
    url.searchParams.set('symbol', next);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  };
  const activePosition =
    positions.data?.data.find(
      (position) => position.symbol === symbol && position.quantity !== '0.00000000',
    ) ?? null;

  return (
    <div className="professional-terminal-page">
      <TournamentStatus
        account={account}
        tournament={tournament.data?.data}
        entries={entries.data?.data ?? []}
        leaderboard={leaderboard.data}
        switching={switching}
        onSwitch={(next) => {
          if (next.id === entryId) return;
          setSwitching(true);
          router.push(`/tournaments/${slug}/trade/${next.id}?symbol=${symbol}`);
        }}
        onExpire={() => tournament.refetch()}
      />
      {disabledReason ? (
        <div className="terminal-integrity-banner" role="status">
          <AlertTriangle aria-hidden="true" /> {disabledReason} Existing positions and history
          remain available.
        </div>
      ) : null}
      <MarketHeader
        symbol={symbol}
        markets={marketMap}
        onSelect={selectMarket}
        freshness={freshness}
      />
      <MarketActivityStrip
        markets={markets.data?.data ?? []}
        activeSymbol={symbol}
        onSelect={selectMarket}
      />
      <div className={cn('professional-terminal-grid', depthCollapsed && 'is-depth-collapsed')}>
        <ChartWorkspace symbol={symbol} position={activePosition} />
        <MarketDepthPanel
          symbol={symbol}
          collapsed={depthCollapsed}
          onToggle={() => setDepthCollapsed((value) => !value)}
        />
        <OrderTicket
          account={account}
          symbol={symbol}
          market={activeMarket}
          disabled={tradeDisabled}
          disabledReason={disabledReason}
          pending={submit.isPending}
          onSubmit={sendOrder}
        />
      </div>
      <AccountStrip account={account} />
      <TerminalPanels
        positions={positions.data?.data ?? []}
        orders={orders.data?.data ?? []}
        fills={fills.data?.data ?? []}
        performance={performance.data?.data}
        leaderboard={leaderboard.data}
        entryId={entryId}
        loadingPositions={positions.isLoading}
        onClose={(position, percentageBps) => {
          if (
            confirmationsEnabled &&
            !window.confirm(
              `Close ${percentageBps / 100}% of the ${position.side} ${position.symbol} paper position?`,
            )
          )
            return;
          sendOrder({
            entryId,
            symbol: position.symbol,
            intent: 'CLOSE',
            positionSide: position.side,
            amount: { type: 'PERCENTAGE', percentageBps },
            execution: { type: 'MARKET' },
          });
        }}
        onCancel={(order) => cancel.mutate(order)}
        onProtect={(position, takeProfit, stopLoss) =>
          protect.mutate({ position, takeProfit, stopLoss })
        }
      />
    </div>
  );
}

export function TradingTerminal(props: { slug: string; entryId: string }) {
  return (
    <AuthGuard>
      <Terminal {...props} />
    </AuthGuard>
  );
}
