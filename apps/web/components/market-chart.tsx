'use client';

import type {
  CandleIntervalDto,
  MarketCandleDto,
  MarketSymbolDto,
  PositionDto,
} from '@trade-the-pool/shared';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineStyle,
  LineSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type SeriesType,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { formatPrice } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import type { ChartType, IndicatorPreferences } from '@/lib/terminal-store';
import { realtimeClient } from '@/lib/realtime-client';
import { ErrorState, LoadingState } from './ui/states';

const intervalSeconds: Record<CandleIntervalDto, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
};

type ExactChartCandle = CandlestickData<UTCTimestamp> & { volume: number | null };
type OverlaySeries = ISeriesApi<'Line'>;

function chartCandle(candle: MarketCandleDto): ExactChartCandle {
  return {
    time: Math.floor(new Date(candle.timestamp).getTime() / 1_000) as UTCTimestamp,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: candle.volume === null ? null : Number(candle.volume),
  };
}

function simpleMovingAverage(
  candles: ExactChartCandle[],
  period: number,
): LineData<UTCTimestamp>[] {
  const points: LineData<UTCTimestamp>[] = [];
  let sum = 0;
  for (let index = 0; index < candles.length; index += 1) {
    sum += candles[index].close;
    if (index >= period) sum -= candles[index - period].close;
    if (index >= period - 1) points.push({ time: candles[index].time, value: sum / period });
  }
  return points;
}

function exponentialMovingAverage(
  candles: ExactChartCandle[],
  period: number,
): LineData<UTCTimestamp>[] {
  if (!candles.length) return [];
  const multiplier = 2 / (period + 1);
  let value = candles[0].close;
  return candles.map((candle, index) => {
    value = index === 0 ? candle.close : (candle.close - value) * multiplier + value;
    return { time: candle.time, value };
  });
}

function bollingerBands(candles: ExactChartCandle[], period: number) {
  const middle = simpleMovingAverage(candles, period);
  const upper: LineData<UTCTimestamp>[] = [];
  const lower: LineData<UTCTimestamp>[] = [];
  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1);
    const mean = middle[index - period + 1].value;
    const deviation = Math.sqrt(
      window.reduce((sum, candle) => sum + (candle.close - mean) ** 2, 0) / period,
    );
    upper.push({ time: candles[index].time, value: mean + deviation * 2 });
    lower.push({ time: candles[index].time, value: mean - deviation * 2 });
  }
  return { middle, upper, lower };
}

function volumeWeightedAveragePrice(candles: ExactChartCandle[]): LineData<UTCTimestamp>[] {
  let weighted = 0;
  let volume = 0;
  const points: LineData<UTCTimestamp>[] = [];
  for (const candle of candles) {
    if (candle.volume === null || candle.volume <= 0) continue;
    weighted += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
    volume += candle.volume;
    points.push({ time: candle.time, value: weighted / volume });
  }
  return points;
}

function relativeStrengthIndex(
  candles: ExactChartCandle[],
  period: number,
): LineData<UTCTimestamp>[] {
  if (candles.length <= period) return [];
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = candles[index].close - candles[index - 1].close;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  const values: LineData<UTCTimestamp>[] = [];
  for (let index = period; index < candles.length; index += 1) {
    if (index > period) {
      const change = candles[index].close - candles[index - 1].close;
      averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
      averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    }
    const value = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
    values.push({ time: candles[index].time, value });
  }
  return values;
}

function macd(candles: ExactChartCandle[]) {
  const fast = exponentialMovingAverage(candles, 12);
  const slow = exponentialMovingAverage(candles, 26);
  const line = candles.map((candle, index) => ({
    time: candle.time,
    value: fast[index].value - slow[index].value,
  }));
  const signalMultiplier = 2 / 10;
  let signalValue = line[0]?.value ?? 0;
  const signal = line.map((point, index) => {
    signalValue =
      index === 0 ? point.value : (point.value - signalValue) * signalMultiplier + signalValue;
    return { time: point.time, value: signalValue };
  });
  const histogram: HistogramData<UTCTimestamp>[] = line.map((point, index) => ({
    time: point.time,
    value: point.value - signal[index].value,
    color: point.value >= signal[index].value ? 'rgba(79,214,161,.45)' : 'rgba(255,107,112,.42)',
  }));
  return { line, signal, histogram };
}

export function MarketChart({
  symbol,
  interval,
  chartType,
  indicators,
  resetToken,
  position,
}: {
  symbol: MarketSymbolDto;
  interval: CandleIntervalDto;
  chartType: ChartType;
  indicators: IndicatorPreferences;
  resetToken: number;
  position: PositionDto | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const mainSeries = useRef<ISeriesApi<SeriesType> | null>(null);
  const candleState = useRef<ExactChartCandle[]>([]);
  const overlaySeries = useRef<Record<string, OverlaySeries>>({});
  const rsiSeries = useRef<OverlaySeries | null>(null);
  const macdSeries = useRef<{
    line: OverlaySeries;
    signal: OverlaySeries;
    histogram: ISeriesApi<'Histogram'>;
  } | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const positionLines = useRef<IPriceLine[]>([]);
  const [crosshair, setCrosshair] = useState<ExactChartCandle | null>(null);
  const indicatorKey = useMemo(() => JSON.stringify(indicators), [indicators]);
  const candles = useQuery({
    queryKey: queryKeys.candles(symbol, interval),
    queryFn: ({ signal }) => api.candles(symbol, interval, 240, signal),
  });

  const updateIndicators = () => {
    const data = candleState.current;
    if (indicators.SMA.enabled)
      overlaySeries.current.sma?.setData(simpleMovingAverage(data, indicators.SMA.period));
    if (indicators.EMA.enabled)
      overlaySeries.current.ema?.setData(exponentialMovingAverage(data, indicators.EMA.period));
    if (indicators.VWAP.enabled)
      overlaySeries.current.vwap?.setData(volumeWeightedAveragePrice(data));
    if (indicators.BOLLINGER.enabled) {
      const bands = bollingerBands(data, indicators.BOLLINGER.period);
      overlaySeries.current.bollingerMiddle?.setData(bands.middle);
      overlaySeries.current.bollingerUpper?.setData(bands.upper);
      overlaySeries.current.bollingerLower?.setData(bands.lower);
    }
    if (indicators.RSI.enabled)
      rsiSeries.current?.setData(relativeStrengthIndex(data, indicators.RSI.period));
    if (indicators.MACD.enabled) {
      const values = macd(data);
      macdSeries.current?.line.setData(values.line);
      macdSeries.current?.signal.setData(values.signal);
      macdSeries.current?.histogram.setData(values.histogram);
    }
    if (indicators.VOLUME.enabled)
      volumeSeries.current?.setData(
        data.flatMap((candle) =>
          candle.volume === null
            ? []
            : [
                {
                  time: candle.time,
                  value: candle.volume,
                  color:
                    candle.close >= candle.open ? 'rgba(79,214,161,.32)' : 'rgba(255,107,112,.28)',
                },
              ],
        ),
      );
  };

  useEffect(() => {
    if (!container.current) return;
    const apiChart = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0a0d10' },
        textColor: '#68747f',
        fontFamily: 'SFMono-Regular, Consolas, monospace',
        fontSize: 11,
        panes: { separatorColor: '#202830', separatorHoverColor: '#35414d' },
      },
      grid: { vertLines: { color: '#141a20' }, horzLines: { color: '#141a20' } },
      crosshair: { vertLine: { color: '#53616d' }, horzLine: { color: '#53616d' } },
      rightPriceScale: { borderColor: '#202830', scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { borderColor: '#202830', timeVisible: true, secondsVisible: false },
      handleScale: true,
      handleScroll: true,
    });
    const primary =
      chartType === 'CANDLES'
        ? apiChart.addSeries(CandlestickSeries, {
            upColor: '#4fd6a1',
            downColor: '#ff6b70',
            borderVisible: false,
            wickUpColor: '#4fd6a1',
            wickDownColor: '#ff6b70',
            priceLineColor: '#8a98a5',
            lastValueVisible: true,
          })
        : apiChart.addSeries(LineSeries, {
            color: '#d8ff4f',
            lineWidth: 2,
            priceLineColor: '#8a98a5',
          });
    chart.current = apiChart;
    mainSeries.current = primary;

    const addOverlay = (key: string, color: string, width: 1 | 2 = 1) => {
      overlaySeries.current[key] = apiChart.addSeries(LineSeries, {
        color,
        lineWidth: width,
        priceLineVisible: false,
        lastValueVisible: false,
      });
    };
    if (indicators.SMA.enabled) addOverlay('sma', '#7db4ff');
    if (indicators.EMA.enabled) addOverlay('ema', '#f0b95d', 2);
    if (indicators.VWAP.enabled) addOverlay('vwap', '#d8ff4f', 2);
    if (indicators.BOLLINGER.enabled) {
      addOverlay('bollingerMiddle', 'rgba(177,189,201,.55)');
      addOverlay('bollingerUpper', '#9d83ff');
      addOverlay('bollingerLower', '#9d83ff');
    }
    if (indicators.RSI.enabled) {
      const pane = apiChart.addPane();
      pane.setStretchFactor(0.28);
      rsiSeries.current = pane.addSeries(LineSeries, {
        color: '#9d83ff',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      });
    }
    if (indicators.MACD.enabled) {
      const pane = apiChart.addPane();
      pane.setStretchFactor(0.3);
      macdSeries.current = {
        line: pane.addSeries(LineSeries, {
          color: '#7db4ff',
          lineWidth: 2,
          priceLineVisible: false,
        }),
        signal: pane.addSeries(LineSeries, {
          color: '#f0b95d',
          lineWidth: 1,
          priceLineVisible: false,
        }),
        histogram: pane.addSeries(HistogramSeries, {
          priceLineVisible: false,
          lastValueVisible: false,
        }),
      };
    }
    if (indicators.VOLUME.enabled) {
      const pane = apiChart.addPane();
      pane.setStretchFactor(0.22);
      volumeSeries.current = pane.addSeries(HistogramSeries, {
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: { type: 'volume' },
      });
    }
    apiChart.panes()[0]?.setStretchFactor(1);
    const crosshairHandler = (parameter: { seriesData: Map<unknown, unknown> }) => {
      const point = parameter.seriesData.get(primary) as
        ExactChartCandle | { value?: number } | undefined;
      if (!point) setCrosshair(null);
      else if ('open' in point) setCrosshair(point as ExactChartCandle);
    };
    apiChart.subscribeCrosshairMove(crosshairHandler);
    return () => {
      apiChart.unsubscribeCrosshairMove(crosshairHandler);
      apiChart.remove();
      chart.current = null;
      mainSeries.current = null;
      overlaySeries.current = {};
      rsiSeries.current = null;
      macdSeries.current = null;
      volumeSeries.current = null;
      positionLines.current = [];
    };
  }, [chartType, indicatorKey]);

  useEffect(() => {
    const series = mainSeries.current;
    if (!series) return;
    for (const line of positionLines.current) series.removePriceLine(line);
    positionLines.current = [];
    if (!position || position.quantity === '0.00000000') return;

    const addPositionLine = (
      value: string | null,
      title: string,
      color: string,
      lineStyle: LineStyle,
      lineWidth: 1 | 2,
    ) => {
      const price = Number(value);
      if (!Number.isFinite(price) || price <= 0) return;
      positionLines.current.push(
        series.createPriceLine({
          price,
          color,
          lineWidth,
          lineStyle,
          axisLabelVisible: true,
          title,
        }),
      );
    };

    addPositionLine(
      position.averageEntryPrice,
      'AVG ENTRY',
      position.side === 'LONG' ? '#4d9b3b' : '#c4575d',
      LineStyle.Dashed,
      2,
    );
    addPositionLine(position.takeProfitPrice, 'TAKE PROFIT', '#4fd6a1', LineStyle.Dotted, 1);
    addPositionLine(position.stopLossPrice, 'STOP LOSS', '#ff6b70', LineStyle.Dotted, 1);

    return () => {
      if (chart.current && mainSeries.current === series)
        for (const line of positionLines.current) series.removePriceLine(line);
      positionLines.current = [];
    };
  }, [position, chartType, indicatorKey]);

  useEffect(() => {
    if (!mainSeries.current || !candles.data) return;
    const data = candles.data.data.map(chartCandle);
    candleState.current = data;
    if (chartType === 'CANDLES') (mainSeries.current as ISeriesApi<'Candlestick'>).setData(data);
    else
      (mainSeries.current as ISeriesApi<'Line'>).setData(
        data.map((candle) => ({ time: candle.time, value: candle.close })),
      );
    updateIndicators();
    chart.current?.timeScale().fitContent();
  }, [candles.data, symbol, interval, chartType, indicatorKey]);

  useEffect(() => {
    return realtimeClient.subscribe(`market:${symbol}`, (event) => {
      if (event.type !== 'market.candle' && event.type !== 'market.price') return;
      if (event.symbol !== symbol || !mainSeries.current) return;
      let next: ExactChartCandle;
      if (event.type === 'market.candle') {
        if (event.interval !== interval) return;
        next = chartCandle(event.candle);
      } else if (event.type === 'market.price') {
        const seconds = Math.floor(new Date(event.marketTimestamp).getTime() / 1_000);
        const bucket = Math.floor(seconds / intervalSeconds[interval]) * intervalSeconds[interval];
        const price = Number(event.price);
        const current = candleState.current.at(-1);
        next =
          current && current.time === bucket
            ? {
                ...current,
                high: Math.max(current.high, price),
                low: Math.min(current.low, price),
                close: price,
              }
            : {
                time: bucket as UTCTimestamp,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: null,
              };
      } else return;
      const current = candleState.current.at(-1);
      if (current && next.time < current.time) return;
      if (current?.time === next.time) candleState.current[candleState.current.length - 1] = next;
      else {
        candleState.current.push(next);
        if (candleState.current.length > 500) candleState.current.shift();
      }
      if (chartType === 'CANDLES') (mainSeries.current as ISeriesApi<'Candlestick'>).update(next);
      else
        (mainSeries.current as ISeriesApi<'Line'>).update({ time: next.time, value: next.close });
      updateIndicators();
    });
  }, [interval, symbol, chartType, indicatorKey]);

  useEffect(() => chart.current?.timeScale().fitContent(), [resetToken]);

  return (
    <div className="chart-wrap">
      {crosshair ? (
        <div className="chart-ohlc tabular" aria-live="polite">
          <span>O {formatPrice(String(crosshair.open))}</span>
          <span>H {formatPrice(String(crosshair.high))}</span>
          <span>L {formatPrice(String(crosshair.low))}</span>
          <span>C {formatPrice(String(crosshair.close))}</span>
        </div>
      ) : null}
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
        aria-label={`${symbol.replace('-', '/')} ${chartType.toLowerCase()} chart`}
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
