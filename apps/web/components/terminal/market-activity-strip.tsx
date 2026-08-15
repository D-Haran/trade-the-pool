import {
  MARKET_REGISTRY,
  type MarketSnapshotDto,
  type MarketSymbolDto,
} from '@trade-the-pool/shared';
import { Activity, ScanLine } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/cn';
import { formatBasisPoints, formatPrice } from '@/lib/format';
import { scanMarkets } from '@/lib/market-scanner';
import { AssetIcon } from './asset-icon';

const MarketTile = memo(function MarketTile({
  market,
  active,
  onSelect,
}: {
  market: MarketSnapshotDto;
  active: boolean;
  onSelect: (symbol: MarketSymbolDto) => void;
}) {
  return (
    <button className={active ? 'is-active' : ''} onClick={() => onSelect(market.symbol)}>
      <AssetIcon symbol={market.symbol} size={20} />
      <span>
        <strong>{market.metadata.baseCurrency}</strong>
        <small className="tabular">{formatPrice(market.price, market.symbol)}</small>
      </span>
      <b
        className={cn(
          'tabular',
          market.change24hBasisPoints?.startsWith('-')
            ? 'negative'
            : market.change24hBasisPoints && market.change24hBasisPoints !== '0' && 'positive',
        )}
      >
        {formatBasisPoints(market.change24hBasisPoints)}
      </b>
    </button>
  );
});

export function MarketActivityStrip({
  markets,
  activeSymbol,
  onSelect,
}: {
  markets: MarketSnapshotDto[];
  activeSymbol: MarketSymbolDto;
  onSelect: (symbol: MarketSymbolDto) => void;
}) {
  const ordered = [...markets].sort(
    (left, right) =>
      MARKET_REGISTRY[left.symbol].sortOrder - MARKET_REGISTRY[right.symbol].sortOrder,
  );
  const signals = scanMarkets(ordered);
  return (
    <section className="market-activity-strip" aria-label="Market watchlist and activity scanner">
      <div className="market-watchlist">
        <div className="market-strip-label">
          <Activity aria-hidden="true" /> WATCHLIST
        </div>
        <div className="market-watchlist-scroll">
          {ordered.map((market) => (
            <MarketTile
              key={market.symbol}
              market={market}
              active={market.symbol === activeSymbol}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
      <div className="market-scanner-pulse">
        <div className="market-strip-label">
          <ScanLine aria-hidden="true" /> MARKET PULSE
        </div>
        <div className="scanner-signals">
          {signals.length ? (
            signals.map((signal) => (
              <button
                key={`${signal.symbol}-${signal.label}`}
                onClick={() => onSelect(signal.symbol)}
              >
                <strong>{signal.symbol.split('-')[0]}</strong>
                <span>{signal.label}</span>
                <b className={signal.direction}>{signal.detail}</b>
              </button>
            ))
          ) : (
            <span className="scanner-empty">Waiting for verified market statistics</span>
          )}
        </div>
      </div>
    </section>
  );
}
