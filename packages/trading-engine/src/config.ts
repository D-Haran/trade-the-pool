import { parseMoney, type Money } from '@trade-the-pool/shared';
import { SUPPORTED_SYMBOLS, type MarketSymbol } from '@trade-the-pool/market-data';

export type ExecutionConfig = {
  allowedSymbols: readonly MarketSymbol[];
  spreadBasisPoints: bigint;
  tradingFeeBasisPoints: bigint;
  maximumSlippageBasisPoints: bigint;
  simulatedLiquidity: Readonly<Record<MarketSymbol, Money>>;
  maximumOrderNotional: Money;
  maximumPositionConcentrationBasisPoints: bigint | null;
  stalePriceThresholdMs: number;
};

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  allowedSymbols: SUPPORTED_SYMBOLS,
  spreadBasisPoints: 5n,
  tradingFeeBasisPoints: 10n,
  maximumSlippageBasisPoints: 20n,
  simulatedLiquidity: {
    'BTC-USD': parseMoney('1000000.00'),
    'ETH-USD': parseMoney('500000.00'),
    'SOL-USD': parseMoney('250000.00'),
  },
  maximumOrderNotional: parseMoney('100000.00'),
  maximumPositionConcentrationBasisPoints: null,
  stalePriceThresholdMs: 30_000,
};
