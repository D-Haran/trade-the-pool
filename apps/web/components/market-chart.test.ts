import { describe, expect, it } from 'vitest';
import type { UTCTimestamp } from 'lightweight-charts';
import {
  bollingerBands,
  exponentialMovingAverage,
  formatChartTimestamp,
  macd,
  relativeStrengthIndex,
  simpleMovingAverage,
  volumeWeightedAveragePrice,
} from '../lib/chart-analysis';

const candles = Array.from({ length: 40 }, (_, index) => ({
  time: (1_700_000_000 + index) as UTCTimestamp,
  open: 100 + index,
  high: 101 + index,
  low: 99 + index,
  close: 100.5 + index,
  volume: index % 7 === 0 ? 0 : 2 + index,
}));

describe('sub-minute chart behavior', () => {
  it('shows seconds only for sub-minute timestamps', () => {
    expect(formatChartTimestamp(1_700_000_005, true, 'en-CA', 'UTC')).toMatch(/:\d{2}:\d{2}/);
    expect(formatChartTimestamp(1_700_000_005, false, 'en-CA', 'UTC')).not.toMatch(/:\d{2}:\d{2}/);
  });

  it('computes every indicator from bars of the active timeframe', () => {
    expect(simpleMovingAverage(candles, 9)).toHaveLength(32);
    expect(exponentialMovingAverage(candles, 9)).toHaveLength(40);
    expect(volumeWeightedAveragePrice(candles).length).toBeGreaterThan(0);
    expect(bollingerBands(candles, 20).upper).toHaveLength(21);
    expect(relativeStrengthIndex(candles, 14)).toHaveLength(26);
    expect(macd(candles).histogram).toHaveLength(40);
  });
});
