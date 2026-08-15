import type { CandleIntervalDto, MarketSymbolDto } from '@trade-the-pool/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ChartType = 'CANDLES' | 'LINE';
export type IndicatorKey = 'SMA' | 'EMA' | 'VWAP' | 'BOLLINGER' | 'RSI' | 'MACD' | 'VOLUME';
export type IndicatorPreferences = Record<IndicatorKey, { enabled: boolean; period: number }>;
export type TerminalTab =
  'POSITIONS' | 'OPEN_ORDERS' | 'ORDER_HISTORY' | 'TRADES' | 'PERFORMANCE' | 'LEADERBOARD';
export type OrderPanelTab = 'ORDER' | 'SELL';

const defaultIndicators: IndicatorPreferences = {
  SMA: { enabled: false, period: 20 },
  EMA: { enabled: true, period: 9 },
  VWAP: { enabled: false, period: 20 },
  BOLLINGER: { enabled: false, period: 20 },
  RSI: { enabled: false, period: 14 },
  MACD: { enabled: false, period: 12 },
  VOLUME: { enabled: true, period: 20 },
};

type TerminalState = {
  symbol: MarketSymbolDto;
  interval: CandleIntervalDto;
  chartType: ChartType;
  indicators: IndicatorPreferences;
  lowerTab: TerminalTab;
  orderPanelTab: OrderPanelTab;
  hotkeysEnabled: boolean;
  confirmationsEnabled: boolean;
  setSymbol: (symbol: MarketSymbolDto) => void;
  setInterval: (interval: CandleIntervalDto) => void;
  setChartType: (chartType: ChartType) => void;
  setIndicator: (key: IndicatorKey, value: Partial<{ enabled: boolean; period: number }>) => void;
  resetIndicators: () => void;
  setLowerTab: (lowerTab: TerminalTab) => void;
  setOrderPanelTab: (orderPanelTab: OrderPanelTab) => void;
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
      orderPanelTab: 'ORDER',
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
      setOrderPanelTab: (orderPanelTab) => set({ orderPanelTab }),
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
