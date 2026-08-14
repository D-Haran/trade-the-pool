'use client';

import type {
  ApiEnvelope,
  EntryDetailDto,
  MarketSnapshotDto,
  OrderRequestDto,
  RealtimeEvent,
  TournamentDto,
} from '@trade-the-pool/shared';
import { ArrowDown, ArrowUp, ChevronDown, Clock3, History, ListTree, Trophy } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiClientError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatPercent, formatPrice, formatQuantity, formatUsd, isPositive } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { isTradable } from '@/lib/tournaments';
import { useTerminalStore } from '@/lib/terminal-store';
import { useRealtime } from '@/hooks/use-realtime';
import { AuthGuard } from './auth-guard';
import { ChartBoundary, MarketChart } from './market-chart';
import { ConnectionStatus } from './connection-status';
import { Countdown } from './countdown';
import { Leaderboard } from './leaderboard';
import { Button } from './ui/button';
import { EmptyState, ErrorState, LoadingState } from './ui/states';
import { useToast } from './ui/toast';

type Side = 'BUY' | 'SELL';
type LowerTab = 'POSITIONS' | 'ORDERS' | 'LEADERBOARD';
const symbols = ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const;
const intervals = ['1m', '5m', '15m', '1h'] as const;

function orderError(error: unknown): string {
  if (!(error instanceof ApiClientError)) return 'The order could not be completed.';
  const messages: Record<string, string> = {
    INSUFFICIENT_CASH: 'Available cash does not cover this order and its fee.',
    INSUFFICIENT_POSITION: 'This entry does not hold enough of the selected asset.',
    STALE_MARKET_PRICE:
      'Authoritative market data is stale. Wait for a fresh price before retrying.',
    TOURNAMENT_NOT_TRADABLE: 'Trading is closed for this tournament.',
    RATE_LIMITED: 'Order submission is temporarily rate limited. Please wait before retrying.',
    AUTHENTICATION_REQUIRED: 'Your session expired. Sign in again before trading.',
    DUPLICATE_ORDER_CONFLICT:
      'This retry no longer matches the original order. Start a new submission.',
  };
  return messages[error.code] ?? error.message;
}

function useMarketStale(timestamp?: string): boolean {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!timestamp) return true;
  const age = now - new Date(timestamp).getTime();
  return age < 0 || age > 30_000;
}

function positiveDecimal(value: string, places: number): boolean {
  const match = new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`).test(value);
  return match && !/^0+(?:\.0+)?$/.test(value);
}

function Terminal({ slug, entryId }: { slug: string; entryId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { symbol, setSymbol } = useTerminalStore();
  const [interval, setInterval] = useState<(typeof intervals)[number]>('5m');
  const [side, setSide] = useState<Side>('BUY');
  const [notional, setNotional] = useState('1000.00');
  const [sellQuantity, setSellQuantity] = useState('');
  const [sellPercentage, setSellPercentage] = useState<number | null>(10_000);
  const [lowerTab, setLowerTab] = useState<LowerTab>('POSITIONS');
  const [switching, setSwitching] = useState(false);
  const [lastFill, setLastFill] = useState<Awaited<ReturnType<typeof api.order>>['data'] | null>(
    null,
  );
  const retryRef = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => setSwitching(false), [entryId]);

  const entry = useQuery({
    queryKey: queryKeys.entry(entryId),
    queryFn: () => api.entry(entryId),
    retry: false,
  });
  const confirmedEntryId = entry.data?.data.id;
  const confirmed = confirmedEntryId === entryId;
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
  const market = useQuery({
    queryKey: queryKeys.market(symbol),
    queryFn: () => api.market(symbol),
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
  const leaderboard = useQuery({
    queryKey: queryKeys.leaderboard(tournamentId ?? 'pending'),
    queryFn: () => api.leaderboard(tournamentId!),
    enabled: Boolean(tournamentId),
  });
  const topics = useMemo(
    () =>
      confirmed && tournamentId
        ? [`market:${symbol}`, `tournament:${tournamentId}`, `entry:${entryId}`]
        : [],
    [confirmed, entryId, symbol, tournamentId],
  );
  const handleEvent = (event: RealtimeEvent) => {
    if (event.type === 'market.price' && event.symbol === symbol)
      queryClient.setQueryData<ApiEnvelope<MarketSnapshotDto>>(queryKeys.market(symbol), {
        data: event,
      });
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.entry(entryId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.positions(entryId) });
    }
    if (event.type === 'tournament.prize_pool_updated') {
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
    }
    if (event.type === 'leaderboard.updated' && tournamentId)
      void queryClient.invalidateQueries({ queryKey: queryKeys.leaderboard(tournamentId) });
    if (event.type === 'tournament.status_changed')
      void queryClient.invalidateQueries({ queryKey: queryKeys.tournament(slug) });
  };
  const connection = useRealtime(topics, handleEvent, () => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.entry(entryId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.positions(entryId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.orders(entryId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.market(symbol) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.leaderboard(tournamentId ?? 'pending') }),
      queryClient.invalidateQueries({ queryKey: queryKeys.tournament(slug) }),
    ]);
  });
  const stale = useMarketStale(market.data?.data.marketTimestamp);
  const currentPosition = positions.data?.data.find(
    (position) => position.symbol === symbol && position.quantity !== '0.00000000',
  );
  const deadlinePassed = tournament.data?.data.tradingClosesAt
    ? Date.now() >= new Date(tournament.data.data.tradingClosesAt).getTime()
    : true;
  const restUnavailable = entry.isError || market.isError || tournament.isError;
  const tradeDisabled =
    !confirmed ||
    switching ||
    stale ||
    restUnavailable ||
    deadlinePassed ||
    !tournament.data ||
    !isTradable(tournament.data.data.status);
  const invalidAmount =
    side === 'BUY'
      ? !positiveDecimal(notional, 2)
      : sellPercentage === null && !positiveDecimal(sellQuantity, 8);

  const submit = useMutation({
    mutationFn: ({ body, key }: { body: OrderRequestDto; key: string }) => api.order(body, key),
    onSuccess: async ({ data }) => {
      retryRef.current = null;
      setLastFill(data);
      toast.push({
        tone: 'success',
        title: `${data.side === 'BUY' ? 'Bought' : 'Sold'} ${formatQuantity(data.quantity)} ${data.symbol.split('-')[0]}`,
        detail: `Fill ${formatPrice(data.fillPrice)} · Fee ${formatUsd(data.fee)}`,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.entry(entryId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.positions(entryId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.orders(entryId) }),
        queryClient.invalidateQueries({ queryKey: ['entries'] }),
        tournamentId
          ? queryClient.invalidateQueries({ queryKey: queryKeys.leaderboard(tournamentId) })
          : Promise.resolve(),
      ]);
    },
    onError: (error) => {
      if (!(error instanceof ApiClientError) || error.status !== 0) retryRef.current = null;
      toast.push({ tone: 'error', title: 'Order rejected', detail: orderError(error) });
    },
  });

  const submitOrder = () => {
    if (!confirmed || !confirmedEntryId || tradeDisabled || submit.isPending) return;
    let body: OrderRequestDto;
    if (side === 'BUY') body = { entryId: confirmedEntryId, symbol, side: 'BUY', notional };
    else if (sellPercentage !== null)
      body = {
        entryId: confirmedEntryId,
        symbol,
        side: 'SELL',
        amount: { type: 'PERCENTAGE', percentageBps: sellPercentage },
      };
    else
      body = {
        entryId: confirmedEntryId,
        symbol,
        side: 'SELL',
        amount: { type: 'QUANTITY', quantity: sellQuantity },
      };
    const fingerprint = JSON.stringify(body);
    const existing = retryRef.current?.fingerprint === fingerprint ? retryRef.current : null;
    const pending = existing ?? { fingerprint, key: crypto.randomUUID() };
    retryRef.current = pending;
    submit.mutate({ body, key: pending.key });
  };

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
  return (
    <div className="terminal-page">
      <header className="terminal-context">
        <div className="entry-switcher">
          <span>{account.tournament.name}</span>
          <label>
            <select
              value={entryId}
              disabled={!entries.data || switching}
              onChange={(event) => {
                const next = entries.data?.data.find((item) => item.id === event.target.value);
                if (!next || next.id === entryId) return;
                setSwitching(true);
                router.push(`/tournaments/${slug}/trade/${next.id}`);
              }}
              aria-label="Active tournament entry"
            >
              {(entries.data?.data ?? [account]).map((item) => (
                <option key={item.id} value={item.id}>
                  Entry #{item.sequenceNumber} · {formatUsd(item.score, { signed: true })}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" />
          </label>
        </div>
        <div className="terminal-deadline">
          <Clock3 aria-hidden="true" />
          <span>Trading closes</span>
          <Countdown
            endsAt={account.tournament.tradingClosesAt}
            onExpire={() => tournament.refetch()}
          />
        </div>
        <ConnectionStatus state={connection} />
      </header>

      {restUnavailable || connection !== 'CONNECTED' || stale ? (
        <div
          className={cn('degraded-banner', restUnavailable && 'degraded-banner--error')}
          role="status"
        >
          {restUnavailable
            ? 'Trading service unavailable. New orders are disabled.'
            : stale
              ? 'Market data is stale. Orders are disabled until a fresh authoritative price arrives.'
              : 'Realtime connection degraded. REST state remains visible while the client reconnects.'}
        </div>
      ) : null}

      <div className="terminal-grid">
        <section className="market-workspace">
          <header className="market-header">
            <div className="symbol-tabs">
              {symbols.map((item) => (
                <button
                  key={item}
                  className={item === symbol ? 'is-active' : ''}
                  onClick={() => setSymbol(item)}
                >
                  {item.replace('-', '/')}
                </button>
              ))}
            </div>
            <div className="market-price">
              <span>{symbol.replace('-', '/')}</span>
              <strong className="tabular">
                {market.data ? formatPrice(market.data.data.price) : '—'}
              </strong>
              <small className={stale ? 'negative' : ''}>
                {stale ? 'STALE' : market.data?.data.source}
              </small>
            </div>
            <div className="interval-tabs" aria-label="Chart interval">
              {intervals.map((item) => (
                <button
                  key={item}
                  className={item === interval ? 'is-active' : ''}
                  onClick={() => setInterval(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </header>
          <ChartBoundary>
            <MarketChart symbol={symbol} interval={interval} />
          </ChartBoundary>
        </section>

        <aside className="account-rail">
          <div className="rank-score">
            <div>
              <span>Rank</span>
              <strong className="tabular">{account.rank ? `#${account.rank}` : '—'}</strong>
            </div>
            <div>
              <span>P&amp;L</span>
              <strong
                className={cn(
                  'tabular',
                  account.score.startsWith('-')
                    ? 'negative'
                    : isPositive(account.score) && 'positive',
                )}
              >
                {formatUsd(account.score, { signed: true })}
              </strong>
            </div>
          </div>
          <div className="account-equity">
            <span>Equity</span>
            <strong className="tabular">{formatUsd(account.equity)}</strong>
            <small
              className={cn(
                'tabular',
                account.percentageReturn.startsWith('-')
                  ? 'negative'
                  : isPositive(account.percentageReturn) && 'positive',
              )}
            >
              {formatPercent(account.percentageReturn)}
            </small>
          </div>
          <div className="account-list">
            <div>
              <span>Locked starting bankroll</span>
              <b className="tabular">{formatUsd(account.startingBankroll)}</b>
            </div>
            <div>
              <span>Cash</span>
              <b className="tabular">{formatUsd(account.cash)}</b>
            </div>
            <div>
              <span>Realized P&amp;L</span>
              <b className="tabular">{formatUsd(account.realizedPnL, { signed: true })}</b>
            </div>
            <div>
              <span>Unrealized P&amp;L</span>
              <b className="tabular">{formatUsd(account.unrealizedPnL, { signed: true })}</b>
            </div>
          </div>
          <div className="pool-context">
            <span>Current prize pool</span>
            <strong className="tabular">
              {tournament.data ? formatUsd(tournament.data.data.currentPrizePool) : '—'}
            </strong>
            <small>{tournament.data?.data.totalEntries ?? '—'} total entries</small>
          </div>
        </aside>

        <aside className="order-ticket">
          <div className="side-tabs">
            <button
              className={side === 'BUY' ? 'is-active buy' : ''}
              onClick={() => setSide('BUY')}
            >
              <ArrowDown aria-hidden="true" /> Buy
            </button>
            <button
              className={side === 'SELL' ? 'is-active sell' : ''}
              onClick={() => setSide('SELL')}
            >
              <ArrowUp aria-hidden="true" /> Sell
            </button>
          </div>
          <div className="ticket-symbol">
            <span>Market</span>
            <strong>{symbol.replace('-', '/')}</strong>
            <small>Market order</small>
          </div>
          {side === 'BUY' ? (
            <>
              <label className="amount-field">
                <span>Notional</span>
                <div>
                  <i>$</i>
                  <input
                    value={notional}
                    onChange={(event) => setNotional(event.target.value)}
                    inputMode="decimal"
                    aria-label="Buy notional in USD"
                  />
                  <b>USD</b>
                </div>
              </label>
              <div className="quick-grid">
                {['250.00', '500.00', '1000.00', '2500.00'].map((value) => (
                  <button key={value} onClick={() => setNotional(value)}>
                    {formatUsd(value)}
                  </button>
                ))}
              </div>
              <div className="ticket-note">
                <span>Available cash</span>
                <b className="tabular">{formatUsd(account.cash)}</b>
              </div>
            </>
          ) : (
            <>
              <div className="sell-available">
                <span>Available position</span>
                <b className="tabular">
                  {currentPosition
                    ? `${formatQuantity(currentPosition.quantity)} ${symbol.split('-')[0]}`
                    : 'No position'}
                </b>
              </div>
              <div className="quick-grid quick-grid--sell">
                {[
                  { label: '25%', value: 2500 },
                  { label: '50%', value: 5000 },
                  { label: '75%', value: 7500 },
                  { label: 'Close', value: 10000 },
                ].map(({ label, value }) => (
                  <button
                    key={value}
                    className={sellPercentage === value ? 'is-active' : ''}
                    onClick={() => setSellPercentage(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="amount-field">
                <span>Exact quantity</span>
                <div>
                  <input
                    value={sellQuantity}
                    onChange={(event) => {
                      setSellQuantity(event.target.value);
                      setSellPercentage(null);
                    }}
                    inputMode="decimal"
                    aria-label={`Sell quantity in ${symbol.split('-')[0]}`}
                  />
                  <b>{symbol.split('-')[0]}</b>
                </div>
              </label>
            </>
          )}
          <Button
            className={cn('submit-order', side === 'SELL' && 'submit-order--sell')}
            disabled={
              tradeDisabled ||
              invalidAmount ||
              submit.isPending ||
              (side === 'SELL' && !currentPosition)
            }
            onClick={submitOrder}
          >
            {submit.isPending
              ? 'Submitting…'
              : stale
                ? 'Market data stale'
                : `${side === 'BUY' ? 'Buy' : 'Sell'} ${symbol.split('-')[0]}`}
          </Button>
          <p className="ticket-disclaimer">
            Fill price and fee are authoritative only after execution. No client price is submitted.
          </p>
          {submit.isError ? (
            <p className="form-error" role="alert">
              {orderError(submit.error)}
            </p>
          ) : null}
          {lastFill ? (
            <div className="fill-receipt">
              <strong>
                {lastFill.side === 'BUY' ? 'Bought' : 'Sold'} {formatQuantity(lastFill.quantity)}{' '}
                {lastFill.symbol.split('-')[0]}
              </strong>
              <span>
                Fill <b>{formatPrice(lastFill.fillPrice)}</b>
              </span>
              <span>
                Fee <b>{formatUsd(lastFill.fee)}</b>
              </span>
            </div>
          ) : null}
        </aside>

        <section className="terminal-lower">
          <div className="lower-tabs">
            <button
              className={lowerTab === 'POSITIONS' ? 'is-active' : ''}
              onClick={() => setLowerTab('POSITIONS')}
            >
              <ListTree aria-hidden="true" /> Positions
            </button>
            <button
              className={lowerTab === 'ORDERS' ? 'is-active' : ''}
              onClick={() => setLowerTab('ORDERS')}
            >
              <History aria-hidden="true" /> Orders
            </button>
            <button
              className={lowerTab === 'LEADERBOARD' ? 'is-active' : ''}
              onClick={() => setLowerTab('LEADERBOARD')}
            >
              <Trophy aria-hidden="true" /> Leaderboard
            </button>
          </div>
          {lowerTab === 'POSITIONS' ? (
            <PositionsPanel positions={positions.data?.data ?? []} loading={positions.isLoading} />
          ) : null}
          {lowerTab === 'ORDERS' ? (
            <OrdersPanel orders={orders.data?.data ?? []} loading={orders.isLoading} />
          ) : null}
          {lowerTab === 'LEADERBOARD' && leaderboard.data ? (
            <Leaderboard leaderboard={leaderboard.data} currentEntryId={entryId} />
          ) : null}
          {lowerTab === 'LEADERBOARD' && leaderboard.isLoading ? (
            <LoadingState label="Loading leaderboard" />
          ) : null}
        </section>
      </div>
    </div>
  );
}

function PositionsPanel({
  positions,
  loading,
}: {
  positions: Awaited<ReturnType<typeof api.positions>>['data'];
  loading: boolean;
}) {
  const active = positions.filter((position) => position.quantity !== '0.00000000');
  if (loading) return <LoadingState label="Loading positions" />;
  if (!active.length)
    return <EmptyState title="No open positions" detail="Your filled buys will appear here." />;
  return (
    <div className="data-table positions-table">
      <div className="data-table__head">
        <span>Market</span>
        <span>Quantity</span>
        <span>Average entry</span>
        <span>Mark</span>
        <span>Market value</span>
        <span>Return</span>
        <span>Unrealized P&amp;L</span>
      </div>
      {active.map((position) => (
        <div key={position.symbol} className="data-table__row">
          <strong>{position.symbol.replace('-', '/')}</strong>
          <span className="tabular">{formatQuantity(position.quantity)}</span>
          <span className="tabular">{formatPrice(position.averageEntryPrice)}</span>
          <span className="tabular">
            {position.currentMark ? formatPrice(position.currentMark) : '—'}
          </span>
          <span className="tabular">{formatUsd(position.marketValue)}</span>
          <span
            className={cn(
              'tabular',
              position.percentageReturn.startsWith('-')
                ? 'negative'
                : isPositive(position.percentageReturn) && 'positive',
            )}
          >
            {formatPercent(position.percentageReturn)}
          </span>
          <strong
            className={cn(
              'tabular',
              position.unrealizedPnL.startsWith('-')
                ? 'negative'
                : isPositive(position.unrealizedPnL) && 'positive',
            )}
          >
            {formatUsd(position.unrealizedPnL, { signed: true })}
          </strong>
        </div>
      ))}
    </div>
  );
}

function OrdersPanel({
  orders,
  loading,
}: {
  orders: Awaited<ReturnType<typeof api.orders>>['data'];
  loading: boolean;
}) {
  if (loading) return <LoadingState label="Loading order history" />;
  if (!orders.length)
    return (
      <EmptyState
        title="No order history"
        detail="Authoritative fills will appear here after your first trade."
      />
    );
  return (
    <div className="data-table orders-table">
      <div className="data-table__head">
        <span>Time</span>
        <span>Market</span>
        <span>Side</span>
        <span>Quantity</span>
        <span>Fill price</span>
        <span>Notional</span>
        <span>Fee</span>
      </div>
      {orders.map((order) => (
        <div key={order.id} className="data-table__row">
          <span>
            {new Intl.DateTimeFormat('en', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }).format(new Date(order.fill?.timestamp ?? order.createdAt))}
          </span>
          <strong>{order.symbol.replace('-', '/')}</strong>
          <span className={order.side === 'BUY' ? 'positive' : 'negative'}>{order.side}</span>
          <span className="tabular">{order.fill ? formatQuantity(order.fill.quantity) : '—'}</span>
          <span className="tabular">{order.fill ? formatPrice(order.fill.fillPrice) : '—'}</span>
          <span className="tabular">{order.fill ? formatUsd(order.fill.notional) : '—'}</span>
          <span className="tabular">{order.fill ? formatUsd(order.fill.fee) : '—'}</span>
        </div>
      ))}
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
