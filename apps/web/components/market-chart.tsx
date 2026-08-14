'use client';

import type { CandleIntervalDto, MarketCandleDto, MarketSymbolDto } from '@trade-the-pool/shared';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Component, useEffect, useRef, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { realtimeClient } from '@/lib/realtime-client';
import { ErrorState, LoadingState } from './ui/states';

const intervalSeconds: Record<CandleIntervalDto, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
};

function chartCandle(candle: MarketCandleDto): CandlestickData<UTCTimestamp> {
  return {
    time: Math.floor(new Date(candle.timestamp).getTime() / 1_000) as UTCTimestamp,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
  };
}

export function MarketChart({
  symbol,
  interval,
}: {
  symbol: MarketSymbolDto;
  interval: CandleIntervalDto;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const latest = useRef<CandlestickData<UTCTimestamp> | null>(null);
  const candles = useQuery({
    queryKey: queryKeys.candles(symbol, interval),
    queryFn: () => api.candles(symbol, interval),
  });

  useEffect(() => {
    if (!container.current) return;
    const apiChart = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0c0f13' },
        textColor: '#6f7b86',
        fontFamily: 'SFMono-Regular, Consolas, monospace',
        fontSize: 11,
      },
      grid: { vertLines: { color: '#151b21' }, horzLines: { color: '#151b21' } },
      crosshair: { vertLine: { color: '#4b5864' }, horzLine: { color: '#4b5864' } },
      rightPriceScale: { borderColor: '#26303a', scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: '#26303a', timeVisible: true, secondsVisible: false },
      handleScale: true,
      handleScroll: true,
    });
    const candleSeries = apiChart.addSeries(CandlestickSeries, {
      upColor: '#4fd6a1',
      downColor: '#ff6b70',
      borderVisible: false,
      wickUpColor: '#4fd6a1',
      wickDownColor: '#ff6b70',
      priceLineColor: '#6f7b86',
      lastValueVisible: true,
    });
    chart.current = apiChart;
    series.current = candleSeries;
    return () => {
      apiChart.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    if (!series.current || !candles.data) return;
    const data = candles.data.data.map(chartCandle);
    series.current.setData(data);
    latest.current = data.at(-1) ?? null;
    chart.current?.timeScale().fitContent();
  }, [candles.data, symbol, interval]);

  useEffect(() => {
    latest.current = null;
    return realtimeClient.subscribe(`market:${symbol}`, (event) => {
      if (event.type !== 'market.price' || event.symbol !== symbol || !series.current) return;
      const seconds = Math.floor(new Date(event.marketTimestamp).getTime() / 1_000);
      const bucket = Math.floor(seconds / intervalSeconds[interval]) * intervalSeconds[interval];
      const price = Number(event.price);
      const current = latest.current;
      const next: CandlestickData<UTCTimestamp> =
        current && current.time === bucket
          ? {
              ...current,
              high: Math.max(current.high, price),
              low: Math.min(current.low, price),
              close: price,
            }
          : { time: bucket as UTCTimestamp, open: price, high: price, low: price, close: price };
      latest.current = next;
      series.current.update(next);
    });
  }, [interval, symbol]);

  return (
    <div className="chart-wrap">
      {candles.isLoading ? (
        <div className="chart-overlay">
          <LoadingState label="Loading market history" />
        </div>
      ) : null}
      {candles.isError ? (
        <div className="chart-overlay">
          <ErrorState title="Chart history unavailable" retry={() => candles.refetch()} />
        </div>
      ) : null}
      <div
        ref={container}
        className="market-chart"
        aria-label={`${symbol.replace('-', '/')} candlestick chart`}
      />
    </div>
  );
}

type BoundaryState = { failed: boolean };
export class ChartBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false };
  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }
  componentDidCatch(): void {}
  render() {
    if (this.state.failed)
      return (
        <ErrorState
          title="Chart could not render"
          detail="Account and trading controls remain available."
          retry={() => this.setState({ failed: false })}
        />
      );
    return this.props.children;
  }
}
