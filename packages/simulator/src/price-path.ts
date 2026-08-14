import { SUPPORTED_SYMBOLS, type MarketSymbol } from '@trade-the-pool/market-data';
import { parsePrice, type Price } from '@trade-the-pool/shared';
import { SeededRandom } from './rng.js';
import type { PricePath, PriceRegime } from './types.js';

const INITIAL: Record<MarketSymbol, Price> = {
  'BTC-USD': parsePrice('100000.00'),
  'ETH-USD': parsePrice('4000.00'),
  'SOL-USD': parsePrice('200.00'),
};

const PARAMETERS: Record<PriceRegime, { drift: number; volatility: number }> = {
  LOW_VOLATILITY_TREND: { drift: 4, volatility: 18 },
  HIGH_VOLATILITY_TREND: { drift: 7, volatility: 65 },
  RANGE_CHOP: { drift: 0, volatility: 35 },
  REVERSAL: { drift: 8, volatility: 42 },
  SHOCK_EVENT: { drift: 1, volatility: 38 },
};

export function generatePricePath(
  regime: PriceRegime,
  steps: number,
  rng: SeededRandom,
): PricePath {
  if (!Number.isInteger(steps) || steps < 4)
    throw new Error('Price path needs at least four steps');
  const paths = {} as Record<MarketSymbol, Price[]>;
  for (const [symbolIndex, symbol] of SUPPORTED_SYMBOLS.entries()) {
    const symbolRng = rng.fork(symbolIndex + 101);
    const values: Price[] = [INITIAL[symbol]];
    const parameters = PARAMETERS[regime];
    for (let step = 1; step < steps; step += 1) {
      let drift = parameters.drift;
      if (regime === 'REVERSAL' && step >= steps / 2) drift = -parameters.drift;
      let returnBasisPoints = Math.round(drift + symbolRng.normal() * parameters.volatility);
      if (regime === 'RANGE_CHOP') {
        const displacement = Number(
          ((values.at(-1)! - INITIAL[symbol]) * 10_000n) / INITIAL[symbol],
        );
        returnBasisPoints -= Math.round(displacement * 0.18);
      }
      if (regime === 'SHOCK_EVENT' && step === Math.floor(steps * 0.62))
        returnBasisPoints += symbolIndex === 1 ? -1_000 : 1_200;
      const previous = values.at(-1)!;
      const next = previous + (previous * BigInt(returnBasisPoints)) / 10_000n;
      values.push((next > 0n ? next : 1n) as Price);
    }
    paths[symbol] = values;
  }
  return paths;
}
