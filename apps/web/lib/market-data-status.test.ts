import { describe, expect, it } from 'vitest';
import { marketDataStatusLabel } from './market-data-status.js';

describe('market data status label', () => {
  it('never presents a healthy fake feed as genuine live data', () => {
    expect(marketDataStatusLabel('fake', 'LIVE')).toBe('DEV DATA');
    expect(marketDataStatusLabel('fake', 'STALE')).toBe('DEV DATA · STALE');
  });

  it('presents a healthy genuine upstream feed as live', () => {
    expect(marketDataStatusLabel('live', 'LIVE')).toBe('LIVE');
  });
});
