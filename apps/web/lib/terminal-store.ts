import type { CandleIntervalDto, MarketSymbolDto } from '@trade-the-pool/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ChartType = 'CANDLES' | 'LINE';
export type IndicatorKey = 'SMA' | 'EMA' | 'BOLLINGER' | 'RSI' | 'MACD';
export type IndicatorPreferences = Record<IndicatorKey, { enabled: boolean; period: number }>;
export type TerminalTab =
  'POSITIONS' | 'OPEN_ORDERS' | 'ORDER_HISTORY' | 'TRADES' | 'PERFORMANCE' | 'LEADERBOARD';

const defaultIndicators: IndicatorPreferences = {
  SMA: { enabled: false, period: 20 },
  EMA: { enabled: true, period: 9 },
  BOLLINGER: { enabled: false, period: 20 },
  RSI: { enabled: false, period: 14 },
  MACD: { enabled: false, period: 12 },
};

type TerminalState = {
  symbol: MarketSymbolDto;
  interval: CandleIntervalDto;
  chartType: ChartType;
  indicators: IndicatorPreferences;
  lowerTab: TerminalTab;
  hotkeysEnabled: boolean;
  confirmationsEnabled: boolean;
  setSymbol: (symbol: MarketSymbolDto) => void;
  setInterval: (interval: CandleIntervalDto) => void;
  setChartType: (chartType: ChartType) => void;
  setIndicator: (key: IndicatorKey, value: Partial<{ enabled: boolean; period: number }>) => void;
  resetIndicators: () => void;
  setLowerTab: (lowerTab: TerminalTab) => void;
  setHotkeysEnabled: (enabled: boolean) => void;
  setConfirmationsEnabled: (enabled: boolean) => void;
};

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set) => ({
      symbol: 'BTC-USD',
      interval: '5m',
      chartType: 'CANDLES',
      indicators: defaultIndicators,
      lowerTab: 'POSITIONS',
      hotkeysEnabled: true,
      confirmationsEnabled: true,
      setSymbol: (symbol) => set({ symbol }),
      setInterval: (interval) => set({ interval }),
      setChartType: (chartType) => set({ chartType }),
      setIndicator: (key, value) =>
        set((state) => ({
          indicators: { ...state.indicators, [key]: { ...state.indicators[key], ...value } },
        })),
      resetIndicators: () => set({ indicators: defaultIndicators }),
      setLowerTab: (lowerTab) => set({ lowerTab }),
      setHotkeysEnabled: (hotkeysEnabled) => set({ hotkeysEnabled }),
      setConfirmationsEnabled: (confirmationsEnabled) => set({ confirmationsEnabled }),
    }),
    {
      name: 'ttp-terminal-preferences-v2',
      storage: createJSONStorage(() => localStorage),
      partialize: ({
        symbol,
        interval,
        chartType,
        indicators,
        lowerTab,
        hotkeysEnabled,
        confirmationsEnabled,
      }) => ({
        symbol,
        interval,
        chartType,
        indicators,
        lowerTab,
        hotkeysEnabled,
        confirmationsEnabled,
      }),
    },
  ),
);
