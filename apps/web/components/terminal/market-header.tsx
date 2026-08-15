'use client';

import {
  MARKET_REGISTRY,
  SUPPORTED_MARKET_SYMBOLS,
  type MarketSnapshotDto,
  type MarketSymbolDto,
} from '@trade-the-pool/shared';
import { ChevronDown, Radio, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatPrice } from '@/lib/format';
import { marketDataStatusLabel } from '@/lib/market-data-status';
import { AssetIcon } from './asset-icon';

const symbols: MarketSymbolDto[] = [...SUPPORTED_MARKET_SYMBOLS];

function changeLabel(value: string | null | undefined): string {
  if (value == null) return '—';
  const basisPoints = BigInt(value);
  const sign = basisPoints > 0n ? '+' : '';
  return `${sign}${(Number(basisPoints) / 100).toFixed(2)}%`;
}

export function MarketHeader({
  symbol,
  markets,
  onSelect,
  freshness,
}: {
  symbol: MarketSymbolDto;
  markets: Partial<Record<MarketSymbolDto, MarketSnapshotDto>>;
  onSelect: (symbol: MarketSymbolDto) => void;
  freshness: 'LIVE' | 'DELAYED' | 'STALE' | 'RECONNECTING' | 'UNAVAILABLE' | 'DEGRADED';
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const active = markets[symbol];
  const displayStatus = marketDataStatusLabel(active?.dataMode, freshness);
  const filtered = useMemo(
    () =>
      symbols.filter((item) => {
        const query = search.toLowerCase();
        return (
          item.toLowerCase().includes(query) ||
          MARKET_REGISTRY[item].displayName.toLowerCase().includes(query)
        );
      }),
    [search],
  );
  return (
    <header className="professional-market-header">
      <div className="market-selector-shell">
        <button
          className="market-selector-trigger"
          onClick={() => setPickerOpen((value) => !value)}
        >
          <AssetIcon symbol={symbol} />
          <span>
            <strong>{symbol.replace('-', '/')}</strong>
            <small>
              {MARKET_REGISTRY[symbol].displayName} · 24/7 · up to{' '}
              {MARKET_REGISTRY[symbol].maxLeverage}x
            </small>
          </span>
          <ChevronDown aria-hidden="true" />
        </button>
        {pickerOpen ? (
          <div className="market-picker" role="dialog" aria-label="Select market">
            <label>
              <Search aria-hidden="true" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search markets"
                autoFocus
              />
            </label>
            <div className="market-picker__head">
              <span>Market</span>
              <span>Last</span>
              <span>24h</span>
            </div>
            {filtered.map((item) => {
              const market = markets[item];
              const change = market?.change24hBasisPoints;
              return (
                <button
                  key={item}
                  className={item === symbol ? 'is-active' : ''}
                  onClick={() => {
                    onSelect(item);
                    setPickerOpen(false);
                    setSearch('');
                  }}
                >
                  <span>
                    <AssetIcon symbol={item} size={24} />
                    <span>
                      <strong>{item.replace('-', '/')}</strong>
                      <small>
                        {MARKET_REGISTRY[item].displayName} · max{' '}
                        {MARKET_REGISTRY[item].maxLeverage}x
                      </small>
                    </span>
                  </span>
                  <b className="tabular">{market ? formatPrice(market.price) : '—'}</b>
                  <b
                    className={cn(
                      'tabular',
                      change?.startsWith('-') ? 'negative' : change && change !== '0' && 'positive',
                    )}
                  >
                    {changeLabel(change)}
                  </b>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="active-market-price">
        <strong className="tabular">{active ? formatPrice(active.price) : '—'}</strong>
        <span
          className={cn(
            'tabular',
            active?.change24hBasisPoints?.startsWith('-') ? 'negative' : 'positive',
          )}
        >
          {changeLabel(active?.change24hBasisPoints)}
        </span>
      </div>

      <dl className="market-stat-strip">
        <div>
          <dt>24H HIGH</dt>
          <dd className="tabular">{active?.high24h ? formatPrice(active.high24h) : '—'}</dd>
        </div>
        <div>
          <dt>24H LOW</dt>
          <dd className="tabular">{active?.low24h ? formatPrice(active.low24h) : '—'}</dd>
        </div>
        {active?.volume24h ? (
          <div>
            <dt>24H VOL</dt>
            <dd className="tabular">{active.volume24h}</dd>
          </div>
        ) : null}
      </dl>
      <span className={`market-freshness market-freshness--${freshness.toLowerCase()}`}>
        <Radio aria-hidden="true" /> {displayStatus}
      </span>
    </header>
  );
}
