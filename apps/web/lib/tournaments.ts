import type { TournamentStatusDto } from '@trade-the-pool/shared';

export function tournamentGroup(status: TournamentStatusDto): 'LIVE' | 'UPCOMING' | 'COMPLETED' {
  if (status === 'REGISTRATION_OPEN' || status === 'TRADING_ACTIVE' || status === 'ENTRY_CLOSED')
    return 'LIVE';
  if (status === 'DRAFT') return 'UPCOMING';
  return 'COMPLETED';
}

export function statusLabel(status: TournamentStatusDto): string {
  const labels: Record<TournamentStatusDto, string> = {
    DRAFT: 'Upcoming',
    REGISTRATION_OPEN: 'Registration open',
    TRADING_ACTIVE: 'Trading active',
    ENTRY_CLOSED: 'Entries closed',
    TRADING_CLOSED: 'Trading closed',
    FINALIZING: 'Finalizing',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled',
  };
  return labels[status];
}

export function isTradable(status: TournamentStatusDto): boolean {
  return status === 'TRADING_ACTIVE' || status === 'ENTRY_CLOSED';
}
