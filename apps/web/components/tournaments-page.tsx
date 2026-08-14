'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { tournamentGroup } from '@/lib/tournaments';
import { EmptyState, ErrorState, LoadingState } from './ui/states';
import { TournamentCard } from './tournament-card';

const sections = ['LIVE', 'UPCOMING', 'COMPLETED'] as const;

export function TournamentsPage() {
  const query = useQuery({ queryKey: queryKeys.tournaments(), queryFn: () => api.tournaments() });
  return (
    <div className="page content-width">
      <header className="page-header">
        <div>
          <span className="eyebrow">Competition</span>
          <h1>Tournaments</h1>
        </div>
        <p>
          Enter with a simulated bankroll based on the live prize pool. Rank by exact dollar
          P&amp;L.
        </p>
      </header>
      {query.isLoading ? <LoadingState label="Loading tournaments" /> : null}
      {query.isError ? (
        <ErrorState title="Tournaments unavailable" retry={() => query.refetch()} />
      ) : null}
      {query.data && !query.data.data.length ? (
        <EmptyState
          title="No tournaments"
          detail="There are no tournament records available right now."
        />
      ) : null}
      {query.data
        ? sections.map((section) => {
            const rows = query.data.data.filter((item) => tournamentGroup(item.status) === section);
            return (
              <section key={section} className="tournament-section">
                <div className="tournament-section__title">
                  <h2>{section}</h2>
                  <span>{rows.length}</span>
                </div>
                {rows.length ? (
                  <div className="tournament-grid">
                    {rows.map((row) => (
                      <TournamentCard key={row.id} tournament={row} />
                    ))}
                  </div>
                ) : (
                  <div className="compact-empty">No {section.toLowerCase()} tournaments</div>
                )}
              </section>
            );
          })
        : null}
    </div>
  );
}
