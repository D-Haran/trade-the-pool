'use client';

import type { LeaderboardPageDto } from '@trade-the-pool/shared';
import { ArrowUpRight, RefreshCw, Trophy } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatUsd, isPositive } from '@/lib/format';
import { selectMiniLeaderboardRows } from '@/lib/mini-leaderboard';

export function MiniLeaderboard({
  leaderboard,
  currentEntryId,
  tournamentSlug,
  loading,
  unavailable,
}: {
  leaderboard?: LeaderboardPageDto;
  currentEntryId: string;
  tournamentSlug: string;
  loading: boolean;
  unavailable: boolean;
}) {
  const rows = useMemo(
    () => (leaderboard ? selectMiniLeaderboardRows(leaderboard, currentEntryId) : []),
    [currentEntryId, leaderboard],
  );
  const previousRanks = useRef(new Map<string, number>());
  const [changed, setChanged] = useState<Set<string>>(new Set());

  useEffect(() => {
    const next = new Map(rows.map((row) => [row.entryId, row.rank]));
    const moved = new Set(
      rows
        .filter((row) => {
          const previous = previousRanks.current.get(row.entryId);
          return previous !== undefined && previous !== row.rank;
        })
        .map((row) => row.entryId),
    );
    previousRanks.current = next;
    if (!moved.size) return;
    setChanged(moved);
    const timer = window.setTimeout(() => setChanged(new Set()), 1_200);
    return () => window.clearTimeout(timer);
  }, [rows]);

  const current =
    leaderboard?.data.find((row) => row.entryId === currentEntryId) ??
    leaderboard?.myRanks.find((row) => row.entryId === currentEntryId);

  return (
    <aside className="mini-leaderboard" aria-labelledby="mini-leaderboard-title">
      <div className="mini-leaderboard__header">
        <div>
          <Trophy aria-hidden="true" />
          <span id="mini-leaderboard-title">TOURNAMENT LEADERBOARD</span>
        </div>
        <RefreshCw aria-hidden="true" />
      </div>
      <div className="mini-leaderboard__body">
        {loading ? <p className="mini-leaderboard__state">Loading live standings…</p> : null}
        {unavailable ? (
          <p className="mini-leaderboard__state">Leaderboard temporarily unavailable</p>
        ) : null}
        {!loading && !unavailable && !rows.length ? (
          <p className="mini-leaderboard__state">No ranked entries yet</p>
        ) : null}
        {!loading && !unavailable
          ? rows.map((row, index) => {
              const previous = rows[index - 1];
              const gap = previous && row.rank - previous.rank > 1;
              const mine = row.entryId === currentEntryId;
              return (
                <div key={row.entryId}>
                  {gap ? <div className="mini-leaderboard__gap">•••</div> : null}
                  <div
                    className={cn(
                      'mini-leaderboard__row',
                      mine && 'is-current',
                      changed.has(row.entryId) && 'is-changing',
                    )}
                  >
                    <strong className="tabular">#{row.rank}</strong>
                    <span>
                      {row.displayName}
                      {mine ? <small>YOU</small> : null}
                    </span>
                    <b
                      className={cn(
                        'tabular',
                        row.score.startsWith('-')
                          ? 'negative'
                          : isPositive(row.score) && 'positive',
                      )}
                    >
                      {formatUsd(row.score, { signed: true })}
                    </b>
                  </div>
                </div>
              );
            })
          : null}
      </div>
      <div className="mini-leaderboard__footer">
        <span>
          Your Rank{' '}
          <b className="tabular">
            {current ? `#${current.rank}` : '—'}
            {leaderboard ? ` of ${leaderboard.pagination.total}` : ''}
          </b>
        </span>
        <Link href={`/tournaments/${tournamentSlug}#leaderboard`}>
          View Full Leaderboard <ArrowUpRight aria-hidden="true" />
        </Link>
      </div>
    </aside>
  );
}
