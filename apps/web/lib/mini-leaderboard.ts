import type { LeaderboardPageDto, LeaderboardRowDto } from '@trade-the-pool/shared';

/**
 * Keeps the compact standings useful at both ends of the table. The API owns ordering and rank;
 * this helper only selects already-ranked rows for presentation.
 */
export function selectMiniLeaderboardRows(
  leaderboard: LeaderboardPageDto,
  currentEntryId: string,
): LeaderboardRowDto[] {
  const current =
    leaderboard.data.find((row) => row.entryId === currentEntryId) ??
    leaderboard.myRanks.find((row) => row.entryId === currentEntryId);

  if (!current || current.rank <= 5) return leaderboard.data.slice(0, 5);

  const selected = [
    ...leaderboard.data.slice(0, 3),
    ...leaderboard.data.filter((row) => Math.abs(row.rank - current.rank) <= 1 && row.rank > 3),
    current,
  ];
  const unique = new Map(selected.map((row) => [row.entryId, row]));
  return [...unique.values()].sort((left, right) => left.rank - right.rank);
}
