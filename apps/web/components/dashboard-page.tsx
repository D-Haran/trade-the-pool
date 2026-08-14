'use client';

import { ArrowRight, CircleDollarSign, Trophy } from 'lucide-react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { formatPercent, formatUsd, isPositive } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { statusLabel } from '@/lib/tournaments';
import { AuthGuard } from './auth-guard';
import { EmptyState, ErrorState, LoadingState } from './ui/states';

function DashboardContent() {
  const entries = useQuery({
    queryKey: queryKeys.entries(),
    queryFn: () => api.entries(),
    retry: false,
  });
  const groups = new Map<string, NonNullable<typeof entries.data>['data']>();
  for (const entry of entries.data?.data ?? [])
    groups.set(entry.tournament.id, [...(groups.get(entry.tournament.id) ?? []), entry]);
  return (
    <div className="page content-width dashboard-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">Portfolio</span>
          <h1>My Entries</h1>
        </div>
        <p>Every tournament account, its authoritative equity, and current competition rank.</p>
      </header>
      {entries.isLoading ? <LoadingState label="Loading your entries" /> : null}
      {entries.isError ? (
        <ErrorState title="Entries unavailable" retry={() => entries.refetch()} />
      ) : null}
      {entries.data && !entries.data.data.length ? (
        <EmptyState
          title="No entries yet"
          detail="Enter an open tournament to create your first simulated trading account."
        />
      ) : null}
      {[...groups.values()].map((rows) => {
        const tournament = rows[0].tournament;
        return (
          <section key={tournament.id} className="entry-group">
            <div className="entry-group__header">
              <div>
                <span className={`status-badge status-badge--${tournament.status.toLowerCase()}`}>
                  {statusLabel(tournament.status)}
                </span>
                <h2>{tournament.name}</h2>
              </div>
              <Link href={`/tournaments/${tournament.slug}`}>
                Tournament details <ArrowRight aria-hidden="true" />
              </Link>
            </div>
            <div className="dashboard-table">
              <div className="dashboard-table__head">
                <span>Entry</span>
                <span>Starting bankroll</span>
                <span>Equity</span>
                <span>Return</span>
                <span>Rank</span>
                <span>P&amp;L</span>
                <span />
              </div>
              {rows.map((entry) => (
                <div key={entry.id} className="dashboard-table__row">
                  <strong>Entry #{entry.sequenceNumber}</strong>
                  <span className="tabular optional-column">
                    {formatUsd(entry.startingBankroll)}
                  </span>
                  <span className="tabular">{formatUsd(entry.equity)}</span>
                  <span
                    className={`tabular optional-column ${entry.percentageReturn.startsWith('-') ? 'negative' : isPositive(entry.percentageReturn) ? 'positive' : ''}`}
                  >
                    {formatPercent(entry.percentageReturn)}
                  </span>
                  <span className="tabular rank-cell">
                    <Trophy aria-hidden="true" />
                    {entry.rank ? `#${entry.rank}` : '—'}
                  </span>
                  <strong
                    className={`tabular ${entry.score.startsWith('-') ? 'negative' : isPositive(entry.score) ? 'positive' : ''}`}
                  >
                    <CircleDollarSign aria-hidden="true" />
                    {formatUsd(entry.score, { signed: true })}
                  </strong>
                  <Link
                    className="button button--secondary button--sm"
                    href={`/tournaments/${tournament.slug}/trade/${entry.id}`}
                  >
                    Trade <ArrowRight aria-hidden="true" />
                  </Link>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function DashboardPage() {
  return (
    <AuthGuard>
      <DashboardContent />
    </AuthGuard>
  );
}
