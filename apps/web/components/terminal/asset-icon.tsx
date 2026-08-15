import { MARKET_REGISTRY, isMarketSymbol, type MarketSymbolDto } from '@trade-the-pool/shared';
import type { CSSProperties, ReactNode } from 'react';

function glyph(symbol: MarketSymbolDto): ReactNode {
  const base = symbol.split('-')[0];
  switch (base) {
    case 'BTC':
      return <span>₿</span>;
    case 'ETH':
      return (
        <svg viewBox="0 0 32 32">
          <path d="M16 3 8.5 16 16 20.4 23.5 16 16 3Zm0 19.2-7.5-4.4L16 29l7.5-11.2L16 22.2Z" />
        </svg>
      );
    case 'SOL':
      return (
        <svg viewBox="0 0 32 32">
          <path d="M8 7h17l-3 4H5l3-4Zm2 7h17l-3 4H7l3-4Zm-2 7h17l-3 4H5l3-4Z" />
        </svg>
      );
    case 'XRP':
      return (
        <svg viewBox="0 0 32 32">
          <path d="M6 7h4.2L16 12.5 21.8 7H26l-7.9 7.6a3 3 0 0 1-4.2 0L6 7Zm20 18h-4.2L16 19.5 10.2 25H6l7.9-7.6a3 3 0 0 1 4.2 0L26 25Z" />
        </svg>
      );
    case 'LINK':
      return (
        <svg viewBox="0 0 32 32">
          <path
            fillRule="evenodd"
            d="m16 3 11 6.5v13L16 29 5 22.5v-13L16 3Zm0 5-6.7 4v8l6.7 4 6.7-4v-8L16 8Z"
          />
        </svg>
      );
    case 'AVAX':
      return (
        <svg viewBox="0 0 32 32">
          <path d="M15.8 4.5c.7 0 1.3.4 1.7 1.1l8 14.2c.7 1.2-.2 2.7-1.6 2.7h-5.2l-2.9-5.1-2.9 5.1H8c-1.4 0-2.3-1.5-1.6-2.7l7.8-14.2c.4-.7.9-1.1 1.6-1.1Z" />
        </svg>
      );
    case 'ADA':
      return (
        <svg viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="3" />
          <circle cx="16" cy="7" r="1.8" />
          <circle cx="16" cy="25" r="1.8" />
          <circle cx="7" cy="16" r="1.8" />
          <circle cx="25" cy="16" r="1.8" />
          <circle cx="9.5" cy="9.5" r="1.4" />
          <circle cx="22.5" cy="9.5" r="1.4" />
          <circle cx="9.5" cy="22.5" r="1.4" />
          <circle cx="22.5" cy="22.5" r="1.4" />
        </svg>
      );
    case 'SUI':
      return (
        <svg viewBox="0 0 32 32">
          <path d="M16 3.5S7.5 13 7.5 19.2a8.5 8.5 0 0 0 17 0C24.5 13 16 3.5 16 3.5Zm0 20.8a5.1 5.1 0 0 1-5.1-5.1c0-2.8 2.9-7.4 5.1-10.2 2.2 2.8 5.1 7.4 5.1 10.2a5.1 5.1 0 0 1-5.1 5.1Z" />
        </svg>
      );
    case 'NEAR':
      return (
        <svg viewBox="0 0 32 32">
          <path
            fillRule="evenodd"
            d="M7 5.5A2.5 2.5 0 0 1 11.3 4L23 19V7l-4 4V6.5A2.5 2.5 0 0 1 23.3 5L25 7v19.5a2.5 2.5 0 0 1-4.4 1.6L9 13v12l4-4v4.5A2.5 2.5 0 0 1 8.7 27L7 25V5.5Z"
          />
        </svg>
      );
    case 'DOGE':
      return <span>Ð</span>;
    case 'LTC':
      return <span>Ł</span>;
    case 'AAVE':
      return <span>A</span>;
    default:
      return <span>{base.slice(0, 1)}</span>;
  }
}

export function AssetIcon({ symbol, size = 28 }: { symbol: string; size?: number }) {
  const known = isMarketSymbol(symbol) ? symbol : null;
  const accent = known ? MARKET_REGISTRY[known].accent : '#52606d';
  return (
    <span
      className="asset-icon"
      style={{ '--asset-accent': accent, width: size, height: size } as CSSProperties}
      aria-hidden="true"
    >
      {known ? glyph(known) : <span>{symbol.slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}
