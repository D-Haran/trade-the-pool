'use client';

import type {
  FillHistoryDto,
  LeaderboardPageDto,
  OrderHistoryDto,
  PerformanceDto,
  PositionDto,
  MarketSymbolDto,
} from '@trade-the-pool/shared';
import {
  Activity,
  BarChart3,
  History,
  ListChecks,
  ShieldCheck,
  Trophy,
  WalletCards,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { formatPercent, formatPrice, formatQuantity, formatUsd, isPositive } from '@/lib/format';
import { useTerminalStore, type TerminalTab } from '@/lib/terminal-store';
import { Leaderboard } from '../leaderboard';
import { EmptyState, LoadingState } from '../ui/states';
import { AssetIcon } from './asset-icon';

const tabs: Array<{ key: TerminalTab; label: string; icon: typeof WalletCards }> = [
  { key: 'POSITIONS', label: 'Positions', icon: WalletCards },
  { key: 'OPEN_ORDERS', label: 'Open Orders', icon: ListChecks },
  { key: 'ORDER_HISTORY', label: 'Order History', icon: History },
  { key: 'TRADES', label: 'Trades', icon: Activity },
  { key: 'PERFORMANCE', label: 'Performance', icon: BarChart3 },
  { key: 'LEADERBOARD', label: 'Leaderboard', icon: Trophy },
];

function outcomeClass(value: string) {
  return value.startsWith('-') ? 'negative' : isPositive(value) ? 'positive' : '';
}

function ProtectionEditor({
  position,
  onSave,
  onCancel,
}: {
  position: PositionDto;
  onSave: (takeProfitPrice: string | null, stopLossPrice: string | null) => void;
  onCancel: () => void;
}) {
  const [takeProfit, setTakeProfit] = useState(position.takeProfitPrice ?? '');
  const [stopLoss, setStopLoss] = useState(position.stopLossPrice ?? '');
  return (
    <div className="protection-editor">
      <label>
        TP
        <input
          value={takeProfit}
          onChange={(event) => setTakeProfit(event.target.value)}
          inputMode="decimal"
        />
      </label>
      <label>
        SL
        <input
          value={stopLoss}
          onChange={(event) => setStopLoss(event.target.value)}
          inputMode="decimal"
        />
      </label>
      <button onClick={() => onSave(takeProfit || null, stopLoss || null)}>Save</button>
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}

function PositionsTable({
  positions,
  loading,
  onClose,
  onProtect,
  activeSymbol,
}: {
  positions: PositionDto[];
  loading: boolean;
  onClose: (position: PositionDto, percentageBps: number) => void;
  onProtect: (position: PositionDto, takeProfit: string | null, stopLoss: string | null) => void;
  activeSymbol: MarketSymbolDto;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const active = positions.filter((position) => position.quantity !== '0.00000000');
  if (loading) return <LoadingState label="Loading positions" />;
  if (!active.length)
    return (
      <EmptyState title="No open positions" detail="Your simulated positions will appear here." />
    );
  return (
    <div className="terminal-table terminal-table--positions">
      <div className="terminal-table__head">
        <span>Symbol</span>
        <span>Side</span>
        <span>Leverage</span>
        <span>Size</span>
        <span>Notional</span>
        <span>Entry / Mark</span>
        <span>P&amp;L / ROI</span>
        <span>Margin</span>
        <span>Liq. Estimate</span>
        <span>TP / SL</span>
        <span>Actions</span>
      </div>
      {active.map((position) => (
        <div className="terminal-table__group" key={position.symbol}>
          <div
            className={cn(
              'terminal-table__row',
              position.symbol === activeSymbol && 'is-active-market-position',
            )}
          >
            <strong className="asset-table-cell">
              <AssetIcon symbol={position.symbol} size={22} />
              {position.symbol.replace('-', '/')}
            </strong>
            <span className={`position-side position-side--${position.side.toLowerCase()}`}>
              {position.side}
            </span>
            <strong className="tabular">{position.leverage}x</strong>
            <span className="tabular">{formatQuantity(position.quantity, position.symbol)}</span>
            <span className="tabular">{formatUsd(position.notional)}</span>
            <span className="stacked-number tabular">
              <b>{formatPrice(position.averageEntryPrice, position.symbol)}</b>
              <small>
                {position.currentMark ? formatPrice(position.currentMark, position.symbol) : '—'}
              </small>
            </span>
            <span className={cn('stacked-number tabular', outcomeClass(position.unrealizedPnL))}>
              <b>{formatUsd(position.unrealizedPnL, { signed: true })}</b>
              <small>{formatPercent(position.percentageReturn)}</small>
            </span>
            <span className="tabular">{formatUsd(position.marginUsed)}</span>
            <span className="tabular">
              {position.liquidationPrice
                ? formatPrice(position.liquidationPrice, position.symbol)
                : '—'}
            </span>
            <button className="protection-cell" onClick={() => setEditing(position.symbol)}>
              <ShieldCheck aria-hidden="true" />
              <span>
                {position.takeProfitPrice
                  ? formatPrice(position.takeProfitPrice, position.symbol)
                  : '—'}{' '}
                /{' '}
                {position.stopLossPrice
                  ? formatPrice(position.stopLossPrice, position.symbol)
                  : '—'}
              </span>
            </button>
            <div className="row-actions">
              <button onClick={() => onClose(position, 2500)}>25%</button>
              <button onClick={() => onClose(position, 5000)}>50%</button>
              <button className="close-all" onClick={() => onClose(position, 10_000)}>
                Close
              </button>
            </div>
          </div>
          {editing === position.symbol ? (
            <ProtectionEditor
              position={position}
              onSave={(takeProfit, stopLoss) => {
                onProtect(position, takeProfit, stopLoss);
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function OrdersTable({
  orders,
  open,
  onCancel,
}: {
  orders: OrderHistoryDto[];
  open: boolean;
  onCancel: (order: OrderHistoryDto) => void;
}) {
  const rows = orders.filter((order) =>
    open
      ? ['PENDING', 'OPEN', 'TRIGGERED'].includes(order.status)
      : !['PENDING', 'OPEN', 'TRIGGERED'].includes(order.status),
  );
  if (!rows.length)
    return (
      <EmptyState
        title={open ? 'No active orders' : 'No order history'}
        detail={
          open
            ? 'Limit, stop, and protection orders will appear here.'
            : 'Completed and cancelled orders will appear here.'
        }
      />
    );
  return (
    <div className="terminal-table terminal-table--orders">
      <div className="terminal-table__head">
        <span>Created</span>
        <span>Symbol</span>
        <span>Position</span>
        <span>Intent</span>
        <span>Type</span>
        <span>Size</span>
        <span>Limit / Stop</span>
        <span>Status</span>
        <span>Fill</span>
        <span>Action</span>
      </div>
      {rows.map((order) => (
        <div className="terminal-table__row" key={order.id}>
          <span>
            {new Intl.DateTimeFormat('en', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }).format(new Date(order.createdAt))}
          </span>
          <strong className="asset-table-cell">
            <AssetIcon symbol={order.symbol} size={20} />
            {order.symbol.replace('-', '/')}
          </strong>
          <span className={`position-side position-side--${order.positionSide.toLowerCase()}`}>
            {order.positionSide} · {order.leverage}x
          </span>
          <span>{order.intent}</span>
          <span>{order.orderType.replace('_', ' ')}</span>
          <span className="tabular">
            {order.requestedNotional
              ? formatUsd(order.requestedNotional)
              : order.requestedPercentageBps
                ? `${order.requestedPercentageBps / 100}%`
                : order.requestedQuantity
                  ? formatQuantity(order.requestedQuantity)
                  : '—'}
          </span>
          <span className="tabular">
            {order.limitPrice
              ? formatPrice(order.limitPrice)
              : order.triggerPrice
                ? formatPrice(order.triggerPrice)
                : 'Market'}
          </span>
          <span className={`order-status order-status--${order.status.toLowerCase()}`}>
            {order.status}
          </span>
          <span className="tabular">
            {order.fill
              ? formatPrice(order.fill.fillPrice)
              : (order.rejectionReason ?? order.cancellationReason ?? '—')}
          </span>
          {open ? (
            <button className="cancel-order" onClick={() => onCancel(order)}>
              Cancel
            </button>
          ) : (
            <span>—</span>
          )}
        </div>
      ))}
    </div>
  );
}

function TradesTable({ fills }: { fills: FillHistoryDto[] }) {
  if (!fills.length)
    return <EmptyState title="No trades" detail="Trades will appear here after execution." />;
  return (
    <div className="terminal-table terminal-table--trades">
      <div className="terminal-table__head">
        <span>Time</span>
        <span>Symbol</span>
        <span>Side</span>
        <span>Position</span>
        <span>Intent</span>
        <span>Quantity</span>
        <span>Reference</span>
        <span>Fill</span>
        <span>Fee</span>
        <span>Realized P&amp;L</span>
      </div>
      {fills.map((fill) => (
        <div className="terminal-table__row" key={fill.id}>
          <span>
            {new Intl.DateTimeFormat('en', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }).format(new Date(fill.timestamp))}
          </span>
          <strong className="asset-table-cell">
            <AssetIcon symbol={fill.symbol} size={20} />
            {fill.symbol.replace('-', '/')}
          </strong>
          <span>{fill.side}</span>
          <span>
            {fill.positionSide} · {fill.leverage}x
          </span>
          <span>{fill.intent}</span>
          <span className="tabular">{formatQuantity(fill.quantity)}</span>
          <span className="tabular">{formatPrice(fill.referencePrice)}</span>
          <span className="tabular">{formatPrice(fill.fillPrice)}</span>
          <span className="tabular">{formatUsd(fill.fee)}</span>
          <strong className={cn('tabular', outcomeClass(fill.realizedPnL))}>
            {formatUsd(fill.realizedPnL, { signed: true })}
          </strong>
        </div>
      ))}
    </div>
  );
}

function PerformancePanel({ performance }: { performance?: PerformanceDto }) {
  if (!performance) return <LoadingState label="Loading performance" />;
  const metrics = [
    ['Current P&L', formatUsd(performance.currentPnL, { signed: true })],
    ['Return', formatPercent(performance.returnPercentage)],
    ['Realized P&L', formatUsd(performance.realizedPnL, { signed: true })],
    ['Unrealized P&L', formatUsd(performance.unrealizedPnL, { signed: true })],
    [
      'Max drawdown',
      performance.maxDrawdown ? formatUsd(performance.maxDrawdown) : 'Not yet durable',
    ],
    ['Closed trades', String(performance.numberOfTrades)],
    [
      'Win rate',
      performance.winRatePercentage ? formatPercent(performance.winRatePercentage) : '—',
    ],
    [
      'Average winner',
      performance.averageWinner ? formatUsd(performance.averageWinner, { signed: true }) : '—',
    ],
    [
      'Average loser',
      performance.averageLoser ? formatUsd(performance.averageLoser, { signed: true }) : '—',
    ],
    [
      'Largest winner',
      performance.largestWinner ? formatUsd(performance.largestWinner, { signed: true }) : '—',
    ],
    [
      'Largest loser',
      performance.largestLoser ? formatUsd(performance.largestLoser, { signed: true }) : '—',
    ],
    ['Profit factor', performance.profitFactor ?? '—'],
  ];
  return (
    <div className="performance-grid">
      {metrics.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong className="tabular">{value}</strong>
        </div>
      ))}
    </div>
  );
}

export function TerminalPanels({
  activeSymbol,
  positions,
  orders,
  fills,
  performance,
  leaderboard,
  entryId,
  loadingPositions,
  onClose,
  onCancel,
  onProtect,
}: {
  activeSymbol: MarketSymbolDto;
  positions: PositionDto[];
  orders: OrderHistoryDto[];
  fills: FillHistoryDto[];
  performance?: PerformanceDto;
  leaderboard?: LeaderboardPageDto;
  entryId: string;
  loadingPositions: boolean;
  onClose: (position: PositionDto, percentageBps: number) => void;
  onCancel: (order: OrderHistoryDto) => void;
  onProtect: (position: PositionDto, takeProfit: string | null, stopLoss: string | null) => void;
}) {
  const { lowerTab, setLowerTab } = useTerminalStore();
  const openCount = orders.filter((order) =>
    ['PENDING', 'OPEN', 'TRIGGERED'].includes(order.status),
  ).length;
  return (
    <section className="professional-terminal-lower">
      <div className="professional-lower-tabs">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={lowerTab === key ? 'is-active' : ''}
            onClick={() => setLowerTab(key)}
          >
            <Icon aria-hidden="true" /> {label}
            {key === 'OPEN_ORDERS' && openCount ? <b>{openCount}</b> : null}
          </button>
        ))}
      </div>
      <div className="professional-panel-body">
        {lowerTab === 'POSITIONS' ? (
          <PositionsTable
            activeSymbol={activeSymbol}
            positions={positions}
            loading={loadingPositions}
            onClose={onClose}
            onProtect={onProtect}
          />
        ) : null}
        {lowerTab === 'OPEN_ORDERS' ? (
          <OrdersTable orders={orders} open onCancel={onCancel} />
        ) : null}
        {lowerTab === 'ORDER_HISTORY' ? (
          <OrdersTable orders={orders} open={false} onCancel={onCancel} />
        ) : null}
        {lowerTab === 'TRADES' ? <TradesTable fills={fills} /> : null}
        {lowerTab === 'PERFORMANCE' ? <PerformancePanel performance={performance} /> : null}
        {lowerTab === 'LEADERBOARD' && leaderboard ? (
          <Leaderboard leaderboard={leaderboard} currentEntryId={entryId} />
        ) : null}
        {lowerTab === 'LEADERBOARD' && !leaderboard ? (
          <LoadingState label="Loading leaderboard" />
        ) : null}
      </div>
    </section>
  );
}
