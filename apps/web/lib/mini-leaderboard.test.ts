import { describe, expect, it } from 'vitest';
import type { LeaderboardPageDto, LeaderboardRowDto } from '@trade-the-pool/shared';
import { selectMiniLeaderboardRows } from './mini-leaderboard';

function row(rank: number): LeaderboardRowDto {
  return {
    rank,
    entryId: `entry-${rank}`,
    displayName: `Trader ${rank}`,
    sequenceNumber: rank,
    score: `${100 - rank}.00`,
    percentageReturn: '1.00',
    startingBankroll: '10000.00',
    equity: '10100.00',
    createdAt: `2026-01-${String(rank).padStart(2, '0')}T00:00:00.000Z`,
  };
}

function page(data: LeaderboardRowDto[], mine: LeaderboardRowDto[] = []): LeaderboardPageDto {
  return {
    data,
    myRanks: mine,
    pagination: { page: 1, pageSize: 50, total: 100, totalPages: 2 },
  };
}

describe('compact leaderboard row selection', () => {
  it('shows the authoritative top five for the leader and any top-five entry', () => {
    const rows = [1, 2, 3, 4, 5, 6].map(row);
    expect(
      selectMiniLeaderboardRows(page(rows, [rows[0]]), 'entry-1').map((item) => item.rank),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(
      selectMiniLeaderboardRows(page(rows, [rows[4]]), 'entry-5').map((item) => item.rank),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it('combines the top three with an available user neighborhood without duplicates', () => {
    const rows = [1, 2, 3, 46, 47, 48].map(row);
    expect(
      selectMiniLeaderboardRows(page(rows, [rows[4]]), 'entry-47').map((item) => item.rank),
    ).toEqual([1, 2, 3, 46, 47, 48]);
  });

  it('falls back to top three plus the exact owned row when neighbors are not on the page', () => {
    const leaders = [1, 2, 3, 4, 5].map(row);
    const last = row(100);
    expect(
      selectMiniLeaderboardRows(page(leaders, [last]), last.entryId).map((item) => item.rank),
    ).toEqual([1, 2, 3, 100]);
  });

  it('preserves server ordering for ties and handles empty standings', () => {
    const tied = [row(1), row(2), row(3)];
    tied[0].score = tied[1].score;
    expect(selectMiniLeaderboardRows(page(tied), 'missing').map((item) => item.entryId)).toEqual([
      'entry-1',
      'entry-2',
      'entry-3',
    ]);
    expect(selectMiniLeaderboardRows(page([]), 'missing')).toEqual([]);
  });
});
