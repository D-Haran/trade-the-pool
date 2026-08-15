'use client';

import type {
  ApiEnvelope,
  MarketOrderBookDto,
  MarketSymbolDto,
  MarketTradeDto,
} from '@trade-the-pool/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import { formatCompactQuantity, formatPrice } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { realtimeClient } from '@/lib/realtime-client';
import { cn } from '@/lib/cn';
import { ChevronLeft, ChevronRight } from 'lucide-react';

type DepthTab = 'BOOK' | 'TRADES';

function percentageWidth(value: string, maximum: number): string {
  if (!maximum) return '0%';
  return `${Math.min(100, (Number(value) / maximum) * 100)}%`;
}

function MarketDepthPanelComponent({
  symbol,
  collapsed,
  onToggle,
}: {
  symbol: MarketSymbolDto;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DepthTab>('BOOK');
  const pendingBook = useRef<MarketOrderBookDto | null>(null);
  const frame = useRef<number | null>(null);
  const book = useQuery({
    queryKey: queryKeys.book(symbol),
    queryFn: ({ signal }) => api.book(symbol, 25, signal),
    refetchInterval: 30_000,
  });
  const trades = useQuery({
    queryKey: queryKeys.marketTrades(symbol),
    queryFn: ({ signal }) => api.marketTrades(symbol, 50, signal),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    pendingBook.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    return realtimeClient.subscribe(`market:${symbol}`, (event) => {
      if (event.type === 'market.book' && event.symbol === symbol) {
        pendingBook.current = event;
        if (frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          const next = pendingBook.current;
          if (next)
            queryClient.setQueryData<ApiEnvelope<MarketOrderBookDto>>(queryKeys.book(symbol), {
              data: next,
            });
        });
      }
      if (event.type === 'market.trades' && event.symbol === symbol)
        queryClient.setQueryData<ApiEnvelope<MarketTradeDto[]>>(
          queryKeys.marketTrades(symbol),
          (current) => {
            const seen = new Set<string>();
            const data = [
              ...event.trades.map((trade) => ({ ...trade, symbol })),
              ...(current?.data ?? []),
            ]
              .filter((trade) => {
                const key = `${trade.venue}:${trade.id}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              })
              .slice(0, 100);
            return { data };
          },
        );
    });
  }, [queryClient, symbol]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const orderBook = book.data?.data;
  const simulated = orderBook?.venue === 'Deterministic';
  const asks = [...(orderBook?.asks ?? [])].slice(0, 12).reverse();
  const bids = (orderBook?.bids ?? []).slice(0, 12);
  const maximumTotal = Math.max(
    0,
    ...asks.map((level) => Number(level.total)),
    ...bids.map((level) => Number(level.total)),
  );
  const spreadPercent = orderBook?.spreadBasisPoints
    ? `${(Number(orderBook.spreadBasisPoints) / 100).toFixed(3)}%`
    : '—';

  return (
    <aside className={cn('market-depth-panel', collapsed && 'is-collapsed')}>
      {collapsed ? (
        <button
          className="market-depth-expand"
          onClick={onToggle}
          aria-label="Expand order book"
          title="Expand order book"
        >
          <ChevronLeft aria-hidden="true" />
          <span>ORDER BOOK</span>
        </button>
      ) : null}
      <div className="market-depth-content" aria-hidden={collapsed}>
        <div className="market-depth-tabs">
          <button className={tab === 'BOOK' ? 'is-active' : ''} onClick={() => setTab('BOOK')}>
            ORDER BOOK
          </button>
          <button className={tab === 'TRADES' ? 'is-active' : ''} onClick={() => setTab('TRADES')}>
            TRADES
          </button>
          <button
            className="market-depth-collapse"
            onClick={onToggle}
            aria-label="Collapse order book"
            title="Collapse order book"
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <div className="market-depth-provenance">
          <span>
            {tab === 'BOOK' ? 'Market depth' : 'Trade tape'} ·{' '}
            {tab === 'BOOK'
              ? (orderBook?.venue ?? 'Unavailable')
              : (trades.data?.data[0]?.venue ?? (simulated ? 'Deterministic' : 'Kraken'))}
          </span>
          <b
            className={cn(
              tab === 'BOOK' && orderBook?.status === 'LIVE' && 'positive',
              tab === 'BOOK' && orderBook?.status && orderBook.status !== 'LIVE' && 'warning',
            )}
          >
            {tab === 'BOOK'
              ? simulated
                ? 'SIMULATED'
                : (orderBook?.status ?? 'UNAVAILABLE')
              : `${trades.data?.data.length ?? 0} PRINTS`}
          </b>
        </div>
        {tab === 'BOOK' ? (
          <div
            className="depth-book"
            aria-label={`${symbol} ${orderBook?.venue ?? 'market'} order book`}
          >
            <div className="depth-head">
              <span>PRICE</span>
              <span>SIZE</span>
              <span>TOTAL</span>
            </div>
            {book.isError ? (
              <p className="market-depth-message">Market depth is temporarily unavailable.</p>
            ) : !orderBook ? (
              <p className="market-depth-message">Loading market depth…</p>
            ) : orderBook.status !== 'LIVE' && !orderBook.asks.length ? (
              <p className="market-depth-message">Market depth is resynchronizing…</p>
            ) : (
              <>
                <div className="depth-side depth-side--asks">
                  {asks.map((level) => (
                    <div className="depth-row" key={`ask-${level.price}`}>
                      <i style={{ width: percentageWidth(level.total, maximumTotal) }} />
                      <span className="negative">{formatPrice(level.price, symbol)}</span>
                      <span>{formatCompactQuantity(level.quantity)}</span>
                      <span>{formatCompactQuantity(level.total)}</span>
                    </div>
                  ))}
                </div>
                <div className="depth-spread">
                  <strong className="tabular">
                    {orderBook.spread ? formatPrice(orderBook.spread, symbol) : '—'}
                  </strong>
                  <span>{spreadPercent}</span>
                </div>
                <div className="depth-side depth-side--bids">
                  {bids.map((level) => (
                    <div className="depth-row" key={`bid-${level.price}`}>
                      <i style={{ width: percentageWidth(level.total, maximumTotal) }} />
                      <span className="positive">{formatPrice(level.price, symbol)}</span>
                      <span>{formatCompactQuantity(level.quantity)}</span>
                      <span>{formatCompactQuantity(level.total)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="trade-tape" aria-label={`${symbol} recent market trades`}>
            <div className="depth-head">
              <span>PRICE</span>
              <span>SIZE</span>
              <span>TIME</span>
            </div>
            {trades.isError ? (
              <p className="market-depth-message">Recent trades are temporarily unavailable.</p>
            ) : !trades.data?.data.length ? (
              <p className="market-depth-message">Waiting for exchange trades…</p>
            ) : (
              trades.data.data.slice(0, 50).map((trade) => (
                <div className="trade-tape-row" key={`${trade.venue}-${trade.id}`}>
                  <span
                    className={
                      trade.side === 'BUY' ? 'positive' : trade.side === 'SELL' ? 'negative' : ''
                    }
                  >
                    {formatPrice(trade.price, symbol)}
                  </span>
                  <span>{formatCompactQuantity(trade.quantity)}</span>
                  <span>
                    {new Intl.DateTimeFormat('en-US', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      hour12: false,
                    }).format(new Date(trade.timestamp))}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

export const MarketDepthPanel = memo(MarketDepthPanelComponent);
MarketDepthPanel.displayName = 'MarketDepthPanel';
