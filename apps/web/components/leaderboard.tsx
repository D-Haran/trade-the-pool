import type { LeaderboardPageDto } from '@trade-the-pool/shared';
import { cn } from '@/lib/cn';
import { formatPercent, formatUsd, isPositive } from '@/lib/format';
import { EmptyState } from './ui/states';

export function Leaderboard({
  leaderboard,
  currentEntryId,
  compact = false,
}: {
  leaderboard: LeaderboardPageDto;
  currentEntryId?: string;
  compact?: boolean;
}) {
  const mine = new Set(leaderboard.myRanks.map((row) => row.entryId));
  if (!leaderboard.data.length)
    return (
      <EmptyState
        title="No ranked entries"
        detail="The leaderboard will populate when entries are created."
      />
    );
  return (
    <div className={cn('leaderboard', compact && 'leaderboard--compact')}>
      <div className="leaderboard__header">
        <span>Rank</span>
        <span>Trader</span>
        <span>Bankroll</span>
        <span>Equity</span>
        <span>Return</span>
        <span>P&amp;L</span>
      </div>
      {leaderboard.data.map((row) => (
        <div
          key={row.entryId}
          className={cn(
            'leaderboard__row',
            mine.has(row.entryId) && 'is-mine',
            currentEntryId === row.entryId && 'is-active',
          )}
        >
          <strong className="rank tabular">#{row.rank}</strong>
          <div className="trader">
            <strong>{row.displayName}</strong>
            <span>
              Entry #{row.sequenceNumber}
              {mine.has(row.entryId) ? ' · You' : ''}
            </span>
          </div>
          <span className="tabular optional-column">{formatUsd(row.startingBankroll)}</span>
          <span className="tabular optional-column">{formatUsd(row.equity)}</span>
          <span
            className={cn(
              'tabular optional-column',
              row.percentageReturn.startsWith('-')
                ? 'negative'
                : isPositive(row.percentageReturn) && 'positive',
            )}
          >
            {formatPercent(row.percentageReturn)}
          </span>
          <strong
            className={cn(
              'tabular score',
              row.score.startsWith('-') ? 'negative' : isPositive(row.score) && 'positive',
            )}
          >
            {formatUsd(row.score, { signed: true })}
          </strong>
        </div>
      ))}
    </div>
  );
}
