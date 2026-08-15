'use client';

import type { CandleIntervalDto, MarketSymbolDto, PositionDto } from '@trade-the-pool/shared';
import { CANDLE_INTERVAL_SECONDS } from '@trade-the-pool/shared';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineStyle,
  LineSeries,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { formatPrice } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import type { ChartType, IndicatorPreferences } from '@/lib/terminal-store';
import { realtimeClient } from '@/lib/realtime-client';
import {
  bollingerBands,
  chartCandle,
  exponentialMovingAverage,
  formatChartTimestamp,
  macd,
  relativeStrengthIndex,
  simpleMovingAverage,
  volumeWeightedAveragePrice,
  type ExactChartCandle,
} from '@/lib/chart-analysis';
import { ErrorState, LoadingState } from './ui/states';

type OverlaySeries = ISeriesApi<'Line'>;

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
  const [subMinuteStatus, setSubMinuteStatus] = useState<'LIVE' | 'STALE' | 'UNAVAILABLE' | null>(
    null,
  );
  const indicatorKey = useMemo(() => JSON.stringify(indicators), [indicators]);
  const subMinute = CANDLE_INTERVAL_SECONDS[interval] < 60;
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
      timeScale: {
        borderColor: '#202830',
        timeVisible: true,
        secondsVisible: subMinute,
        barSpacing: subMinute ? 6 : 5,
      },
      localization: {
        timeFormatter: (time: Time) => formatChartTimestamp(Number(time), subMinute),
      },
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
  }, [chartType, indicatorKey, subMinute]);

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
    const visibleBars = interval === '1s' ? 180 : 240;
    chart.current?.timeScale().setVisibleLogicalRange({
      from: Math.max(0, data.length - visibleBars),
      to: Math.max(visibleBars, data.length - 1) + 2,
    });
  }, [candles.data, symbol, interval, chartType, indicatorKey]);

  useEffect(() => {
    setSubMinuteStatus(null);
    const handle = (event: Parameters<Parameters<typeof realtimeClient.subscribe>[1]>[0]) => {
      if (event.type === 'market.candle_status') {
        if (event.symbol === symbol && event.interval === interval)
          setSubMinuteStatus(event.status);
        return;
      }
      if (event.type !== 'market.candle' && event.type !== 'market.price') return;
      if (event.symbol !== symbol || !mainSeries.current) return;
      let next: ExactChartCandle;
      if (event.type === 'market.candle') {
        if (event.interval !== interval) return;
        if (subMinute) setSubMinuteStatus('LIVE');
        next = chartCandle(event.candle);
      } else if (event.type === 'market.price' && !subMinute) {
        const seconds = Math.floor(new Date(event.marketTimestamp).getTime() / 1_000);
        const bucket =
          Math.floor(seconds / CANDLE_INTERVAL_SECONDS[interval]) *
          CANDLE_INTERVAL_SECONDS[interval];
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
    };
    let unsubscribeCandle: () => void = () => undefined;
    const subscriptionTimer = window.setTimeout(() => {
      unsubscribeCandle = realtimeClient.subscribe(`market:${symbol}:candles:${interval}`, handle);
    }, 50);
    const unsubscribePrice = subMinute
      ? () => undefined
      : realtimeClient.subscribe(`market:${symbol}`, handle);
    return () => {
      window.clearTimeout(subscriptionTimer);
      unsubscribeCandle();
      unsubscribePrice();
    };
  }, [interval, symbol, chartType, indicatorKey, subMinute]);

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
      {!candles.isLoading && !candles.isError && subMinute && candles.data?.data.length === 0 ? (
        <div className="chart-overlay">
          <ErrorState title={`${interval} market data is temporarily unavailable`} />
        </div>
      ) : null}
      {subMinute && subMinuteStatus && subMinuteStatus !== 'LIVE' && candles.data?.data.length ? (
        <div className="chart-overlay">
          <ErrorState title={`${interval} market data is temporarily unavailable`} />
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
