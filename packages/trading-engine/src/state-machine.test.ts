import { describe, expect, it } from 'vitest';
import { DomainError, scheduledTournamentStatus, transitionTournament } from './index.js';

describe('scheduled tournament state machine', () => {
  it('allows the explicit lifecycle transitions', () => {
    expect(transitionTournament('DRAFT', 'REGISTRATION_OPEN')).toBe('REGISTRATION_OPEN');
    expect(transitionTournament('REGISTRATION_OPEN', 'TRADING_ACTIVE')).toBe('TRADING_ACTIVE');
    expect(transitionTournament('TRADING_ACTIVE', 'ENTRY_CLOSED')).toBe('ENTRY_CLOSED');
    expect(transitionTournament('ENTRY_CLOSED', 'TRADING_CLOSED')).toBe('TRADING_CLOSED');
    expect(transitionTournament('TRADING_CLOSED', 'FINALIZING')).toBe('FINALIZING');
    expect(transitionTournament('FINALIZING', 'COMPLETED')).toBe('COMPLETED');
  });

  it('rejects every invalid shortcut and terminal transition', () => {
    expect(() => transitionTournament('DRAFT', 'TRADING_ACTIVE')).toThrow(DomainError);
    expect(() => transitionTournament('REGISTRATION_OPEN', 'ENTRY_CLOSED')).toThrow(DomainError);
    expect(() => transitionTournament('COMPLETED', 'CANCELLED')).toThrow(DomainError);
    expect(() => transitionTournament('CANCELLED', 'DRAFT')).toThrow(DomainError);
  });

  it('derives each time-boundary state without a participant threshold', () => {
    const schedule = {
      registrationOpensAt: new Date('2030-01-01T00:00:00Z'),
      tradingStartsAt: new Date('2030-01-01T01:00:00Z'),
      entryClosesAt: new Date('2030-01-01T02:00:00Z'),
      tradingClosesAt: new Date('2030-01-01T03:00:00Z'),
    };
    expect(scheduledTournamentStatus('DRAFT', schedule, new Date('2029-12-31T23:59:59Z'))).toBe(
      'DRAFT',
    );
    expect(scheduledTournamentStatus('DRAFT', schedule, schedule.registrationOpensAt)).toBe(
      'REGISTRATION_OPEN',
    );
    expect(scheduledTournamentStatus('DRAFT', schedule, schedule.tradingStartsAt)).toBe(
      'TRADING_ACTIVE',
    );
    expect(scheduledTournamentStatus('DRAFT', schedule, schedule.entryClosesAt)).toBe(
      'ENTRY_CLOSED',
    );
    expect(scheduledTournamentStatus('DRAFT', schedule, schedule.tradingClosesAt)).toBe(
      'TRADING_CLOSED',
    );
  });
});
