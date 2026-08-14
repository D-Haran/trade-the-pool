import { DomainError } from './errors.js';

export type TournamentStatus =
  | 'DRAFT'
  | 'REGISTRATION_OPEN'
  | 'TRADING_ACTIVE'
  | 'ENTRY_CLOSED'
  | 'TRADING_CLOSED'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'CANCELLED';

export type TournamentSchedule = {
  registrationOpensAt: Date;
  tradingStartsAt: Date;
  entryClosesAt: Date;
  tradingClosesAt: Date;
};

const transitions: Record<Exclude<TournamentStatus, 'CANCELLED'>, readonly TournamentStatus[]> = {
  DRAFT: ['REGISTRATION_OPEN', 'CANCELLED'],
  REGISTRATION_OPEN: ['TRADING_ACTIVE', 'CANCELLED'],
  TRADING_ACTIVE: ['ENTRY_CLOSED', 'CANCELLED'],
  ENTRY_CLOSED: ['TRADING_CLOSED', 'CANCELLED'],
  TRADING_CLOSED: ['FINALIZING', 'CANCELLED'],
  FINALIZING: ['COMPLETED'],
  COMPLETED: [],
};

export function validateTournamentSchedule(schedule: TournamentSchedule): void {
  const times = [
    schedule.registrationOpensAt,
    schedule.tradingStartsAt,
    schedule.entryClosesAt,
    schedule.tradingClosesAt,
  ].map((date) => date.getTime());
  if (
    times.some((time) => !Number.isFinite(time)) ||
    times[0] > times[1] ||
    times[1] >= times[2] ||
    times[2] > times[3]
  )
    throw new DomainError('INVALID_TOURNAMENT_SCHEDULE', 'Tournament schedule is invalid');
}

export function scheduledTournamentStatus(
  persistedStatus: TournamentStatus,
  schedule: TournamentSchedule,
  now: Date,
): TournamentStatus {
  validateTournamentSchedule(schedule);
  if (['TRADING_CLOSED', 'FINALIZING', 'COMPLETED', 'CANCELLED'].includes(persistedStatus))
    return persistedStatus;
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp))
    throw new DomainError('INVALID_TOURNAMENT_SCHEDULE', 'Current time is invalid');
  if (timestamp < schedule.registrationOpensAt.getTime()) return 'DRAFT';
  if (timestamp < schedule.tradingStartsAt.getTime()) return 'REGISTRATION_OPEN';
  if (timestamp < schedule.entryClosesAt.getTime()) return 'TRADING_ACTIVE';
  if (timestamp < schedule.tradingClosesAt.getTime()) return 'ENTRY_CLOSED';
  return 'TRADING_CLOSED';
}

export function transitionTournament(
  status: TournamentStatus,
  next: TournamentStatus,
): TournamentStatus {
  if (status === 'CANCELLED' || !transitions[status].includes(next))
    throw new DomainError(
      'INVALID_TOURNAMENT_TRANSITION',
      `Cannot transition tournament from ${status} to ${next}`,
    );
  return next;
}

export function assertEntryWindow(
  status: TournamentStatus,
  schedule: TournamentSchedule,
  now: Date,
): void {
  const effective = scheduledTournamentStatus(status, schedule, now);
  if (effective === 'DRAFT')
    throw new DomainError('REGISTRATION_NOT_OPEN', 'Tournament registration has not opened');
  if (effective !== 'REGISTRATION_OPEN' && effective !== 'TRADING_ACTIVE')
    throw new DomainError('ENTRY_CLOSED', 'Tournament entry period has closed');
}

export function assertTradingWindow(
  status: TournamentStatus,
  schedule: TournamentSchedule,
  now: Date,
): void {
  const effective = scheduledTournamentStatus(status, schedule, now);
  if (effective === 'DRAFT' || effective === 'REGISTRATION_OPEN')
    throw new DomainError('TRADING_NOT_STARTED', 'Tournament trading has not started');
  if (effective !== 'TRADING_ACTIVE' && effective !== 'ENTRY_CLOSED')
    throw new DomainError('TOURNAMENT_NOT_TRADABLE', 'Tournament trading is closed');
}
