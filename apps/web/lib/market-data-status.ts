import type { MarketSnapshotDto } from '@trade-the-pool/shared';

export function marketDataStatusLabel(
  mode: MarketSnapshotDto['dataMode'] | undefined,
  freshness: MarketSnapshotDto['status'],
): string {
  if (mode !== 'fake') return freshness;
  return freshness === 'LIVE' ? 'DEV DATA' : `DEV DATA · ${freshness}`;
}
