import { describe, expect, it } from 'vitest';
import { DomainError, transitionTournament } from './index.js';
describe('tournament state machine', () => {
  it('allows the lifecycle transitions', () => {
    expect(transitionTournament('DRAFT', 'OPEN')).toBe('OPEN');
    expect(transitionTournament('OPEN', 'ENTRY_CLOSED')).toBe('ENTRY_CLOSED');
    expect(transitionTournament('ENTRY_CLOSED', 'TRADING_CLOSED')).toBe('TRADING_CLOSED');
    expect(transitionTournament('TRADING_CLOSED', 'FINALIZING')).toBe('FINALIZING');
    expect(transitionTournament('FINALIZING', 'COMPLETED')).toBe('COMPLETED');
  });
  it('rejects invalid transitions', () => {
    expect(() => transitionTournament('DRAFT', 'COMPLETED')).toThrow(DomainError);
    expect(() => transitionTournament('COMPLETED', 'CANCELLED')).toThrow(DomainError);
  });
});
