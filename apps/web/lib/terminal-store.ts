import type { MarketSymbolDto } from '@trade-the-pool/shared';
import { create } from 'zustand';

type TerminalState = {
  symbol: MarketSymbolDto;
  setSymbol: (symbol: MarketSymbolDto) => void;
};

export const useTerminalStore = create<TerminalState>((set) => ({
  symbol: 'BTC-USD',
  setSymbol: (symbol) => set({ symbol }),
}));
