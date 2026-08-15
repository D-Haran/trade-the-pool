import type { MarketCandleDto } from '@trade-the-pool/shared';
import type { CandlestickData, HistogramData, LineData, UTCTimestamp } from 'lightweight-charts';

export type ExactChartCandle = CandlestickData<UTCTimestamp> & { volume: number | null };

export function chartCandle(candle: MarketCandleDto): ExactChartCandle {
  return {
    time: Math.floor(new Date(candle.timestamp).getTime() / 1_000) as UTCTimestamp,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: candle.volume === null ? null : Number(candle.volume),
  };
}

export function simpleMovingAverage(
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

export function exponentialMovingAverage(
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

export function bollingerBands(candles: ExactChartCandle[], period: number) {
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

export function volumeWeightedAveragePrice(candles: ExactChartCandle[]): LineData<UTCTimestamp>[] {
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

export function relativeStrengthIndex(
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
    values.push({
      time: candles[index].time,
      value: averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss),
    });
  }
  return values;
}

export function macd(candles: ExactChartCandle[]) {
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

export function formatChartTimestamp(
  timestampSeconds: number,
  showSeconds: boolean,
  locale?: string,
  timeZone?: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...(showSeconds ? { second: '2-digit' } : {}),
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(timestampSeconds * 1_000));
}
