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
  maximumGrossLeverage: 5;
  maintenanceMarginBasisPoints: bigint;
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
    'XRP-USD': parseMoney('250000.00'),
    'DOGE-USD': parseMoney('200000.00'),
    'LINK-USD': parseMoney('150000.00'),
    'AVAX-USD': parseMoney('125000.00'),
    'ADA-USD': parseMoney('125000.00'),
    'SUI-USD': parseMoney('100000.00'),
    'AAVE-USD': parseMoney('75000.00'),
    'NEAR-USD': parseMoney('75000.00'),
    'LTC-USD': parseMoney('150000.00'),
  },
  maximumOrderNotional: parseMoney('500000.00'),
  maximumPositionConcentrationBasisPoints: null,
  maximumGrossLeverage: 5,
  maintenanceMarginBasisPoints: 2_000n,
  stalePriceThresholdMs: 30_000,
};
