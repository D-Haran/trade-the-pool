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
import { formatBaseVolume, formatBasisPoints, formatPrice } from '@/lib/format';
import { marketDataStatusLabel } from '@/lib/market-data-status';
import { AssetIcon } from './asset-icon';

const symbols: MarketSymbolDto[] = [...SUPPORTED_MARKET_SYMBOLS];

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
                  <b className="tabular">
                    {market ? formatPrice(market.price, market.symbol) : '—'}
                  </b>
                  <b
                    className={cn(
                      'tabular',
                      change?.startsWith('-') ? 'negative' : change && change !== '0' && 'positive',
                    )}
                  >
                    {formatBasisPoints(change)}
                  </b>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="active-market-price">
        <strong className="tabular">
          {active ? formatPrice(active.price, active.symbol) : '—'}
        </strong>
        <span
          className={cn(
            'tabular',
            active?.change24hBasisPoints?.startsWith('-')
              ? 'negative'
              : active?.change24hBasisPoints && active.change24hBasisPoints !== '0' && 'positive',
          )}
        >
          {formatBasisPoints(active?.change24hBasisPoints)}
        </span>
      </div>

      <dl className="market-stat-strip">
        <div>
          <dt>24H HIGH</dt>
          <dd className="tabular">{active?.high24h ? formatPrice(active.high24h, symbol) : '—'}</dd>
        </div>
        <div>
          <dt>24H LOW</dt>
          <dd className="tabular">{active?.low24h ? formatPrice(active.low24h, symbol) : '—'}</dd>
        </div>
        {active?.volume24h ? (
          <div>
            <dt>24H VOLUME</dt>
            <dd className="tabular">{formatBaseVolume(active.volume24h, symbol)}</dd>
          </div>
        ) : null}
      </dl>
      <div className="market-mode-status">
        <span className={`market-freshness market-freshness--${freshness.toLowerCase()}`}>
          <Radio aria-hidden="true" /> {displayStatus}
        </span>
        <span className="paper-mode-badge">PAPER</span>
      </div>
    </header>
  );
}
