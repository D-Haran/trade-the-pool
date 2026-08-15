'use client';

import {
  CANDLE_INTERVALS,
  type CandleIntervalDto,
  type MarketSymbolDto,
  type PositionDto,
} from '@trade-the-pool/shared';
import {
  BarChart3,
  CandlestickChart,
  Expand,
  LineChart,
  MoreHorizontal,
  RotateCcw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { memo, useState } from 'react';
import {
  useTerminalStore,
  type ChartType,
  type IndicatorKey,
  type IndicatorPreferences,
} from '@/lib/terminal-store';
import { ChartBoundary, MarketChart } from '../market-chart';

const intervals: readonly CandleIntervalDto[] = CANDLE_INTERVALS.filter(
  (interval) => interval !== '1s',
);
const indicatorLabels: Record<IndicatorKey, { label: string; description: string }> = {
  SMA: { label: 'SMA', description: 'Simple moving average' },
  EMA: { label: 'EMA', description: 'Exponential moving average' },
  VWAP: { label: 'VWAP', description: 'Volume-weighted average price' },
  BOLLINGER: { label: 'Bollinger Bands', description: '20-period, 2 deviations' },
  RSI: { label: 'RSI', description: 'Relative strength index' },
  MACD: { label: 'MACD', description: '12 / 26 / 9 momentum' },
  VOLUME: { label: 'Volume', description: 'Exchange traded base volume' },
};

function IndicatorManager({
  indicators,
  onClose,
}: {
  indicators: IndicatorPreferences;
  onClose: () => void;
}) {
  const setIndicator = useTerminalStore((state) => state.setIndicator);
  const resetIndicators = useTerminalStore((state) => state.resetIndicators);
  const [search, setSearch] = useState('');
  const keys = (Object.keys(indicatorLabels) as IndicatorKey[]).filter((key) =>
    indicatorLabels[key].label.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="indicator-popover" role="dialog" aria-label="Indicators">
      <div className="indicator-popover__head">
        <div>
          <strong>Indicators</strong>
          <span>Calculated locally from normalized exchange candles</span>
        </div>
        <button onClick={onClose} aria-label="Close indicators">
          <X aria-hidden="true" />
        </button>
      </div>
      <input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search indicators"
        aria-label="Search indicators"
      />
      <div className="indicator-list">
        {keys.map((key) => (
          <div key={key} className="indicator-row">
            <label>
              <input
                type="checkbox"
                checked={indicators[key].enabled}
                onChange={(event) => setIndicator(key, { enabled: event.target.checked })}
              />
              <span>
                <strong>{indicatorLabels[key].label}</strong>
                <small>{indicatorLabels[key].description}</small>
              </span>
            </label>
            {!['MACD', 'VWAP', 'VOLUME'].includes(key) ? (
              <input
                type="number"
                min={2}
                max={200}
                value={indicators[key].period}
                onChange={(event) =>
                  setIndicator(key, {
                    period: Math.min(200, Math.max(2, Number(event.target.value) || 2)),
                  })
                }
                aria-label={`${indicatorLabels[key].label} period`}
              />
            ) : (
              <span className="indicator-fixed">{key === 'MACD' ? '12 · 26 · 9' : 'SOURCE'}</span>
            )}
          </div>
        ))}
      </div>
      <div className="indicator-unavailable">
        VWAP and Volume use exchange-reported candle volume and remain blank when volume is
        unavailable.
      </div>
      <button className="indicator-reset" onClick={resetIndicators}>
        Reset defaults
      </button>
    </div>
  );
}

function ChartWorkspaceComponent({
  symbol,
  position,
}: {
  symbol: MarketSymbolDto;
  position: PositionDto | null;
}) {
  const interval = useTerminalStore((state) => state.interval);
  const setInterval = useTerminalStore((state) => state.setInterval);
  const chartType = useTerminalStore((state) => state.chartType);
  const setChartType = useTerminalStore((state) => state.setChartType);
  const indicators = useTerminalStore((state) => state.indicators);
  const [indicatorOpen, setIndicatorOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const activeCount = Object.values(indicators).filter((indicator) => indicator.enabled).length;
  const setType = (type: ChartType) => setChartType(type);
  return (
    <section className={fullscreen ? 'chart-workspace is-fullscreen' : 'chart-workspace'}>
      <div className="chart-toolbar">
        <div className="timeframe-tabs" aria-label="Chart timeframe">
          {intervals.map((item) => (
            <button
              key={item}
              className={item === interval ? 'is-active' : ''}
              onClick={() => setInterval(item)}
            >
              {item}
            </button>
          ))}
          <div className="timeframe-more">
            <button
              className={interval === '1s' ? 'is-active' : ''}
              onClick={() => setMoreOpen((value) => !value)}
              aria-label="More timeframes"
            >
              <MoreHorizontal aria-hidden="true" />
            </button>
            {moreOpen ? (
              <div className="timeframe-more__menu">
                <button
                  className={interval === '1s' ? 'is-active' : ''}
                  onClick={() => {
                    setInterval('1s');
                    setMoreOpen(false);
                  }}
                >
                  1s <small>Experimental</small>
                </button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="chart-toolbar__actions">
          <div className="chart-type-toggle" aria-label="Chart type">
            <button
              className={chartType === 'CANDLES' ? 'is-active' : ''}
              onClick={() => setType('CANDLES')}
              aria-label="Candlestick chart"
            >
              <CandlestickChart aria-hidden="true" />
            </button>
            <button
              className={chartType === 'LINE' ? 'is-active' : ''}
              onClick={() => setType('LINE')}
              aria-label="Line chart"
            >
              <LineChart aria-hidden="true" />
            </button>
          </div>
          <button
            className={indicatorOpen ? 'is-active' : ''}
            onClick={() => setIndicatorOpen((value) => !value)}
          >
            <BarChart3 aria-hidden="true" /> Indicators
            {activeCount ? <b>{activeCount}</b> : null}
          </button>
          <button onClick={() => setResetToken((value) => value + 1)} aria-label="Reset chart view">
            <RotateCcw aria-hidden="true" /> <span>Reset</span>
          </button>
          <button
            onClick={() => setFullscreen((value) => !value)}
            aria-label="Toggle chart fullscreen"
          >
            {fullscreen ? <X aria-hidden="true" /> : <Expand aria-hidden="true" />}
            <span>{fullscreen ? 'Exit' : 'Focus'}</span>
          </button>
          <button aria-label="Chart settings" onClick={() => setIndicatorOpen(true)}>
            <SlidersHorizontal aria-hidden="true" />
          </button>
        </div>
      </div>
      {indicatorOpen ? (
        <IndicatorManager indicators={indicators} onClose={() => setIndicatorOpen(false)} />
      ) : null}
      <ChartBoundary>
        <MarketChart
          symbol={symbol}
          interval={interval}
          chartType={chartType}
          indicators={indicators}
          resetToken={resetToken}
          position={position}
        />
      </ChartBoundary>
    </section>
  );
}

export const ChartWorkspace = memo(ChartWorkspaceComponent);
ChartWorkspace.displayName = 'ChartWorkspace';
