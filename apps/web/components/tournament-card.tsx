import type { TournamentDto } from '@trade-the-pool/shared';
import { ArrowUpRight, Timer, UsersRound } from 'lucide-react';
import Link from 'next/link';
import { Countdown } from './countdown';
import { formatCompactUsd, formatUsd } from '@/lib/format';
import { statusLabel } from '@/lib/tournaments';

export function TournamentCard({ tournament }: { tournament: TournamentDto }) {
  return (
    <Link href={`/tournaments/${tournament.slug}`} className="tournament-card">
      <div className="tournament-card__top">
        <span className={`status-badge status-badge--${tournament.status.toLowerCase()}`}>
          {statusLabel(tournament.status)}
        </span>
        <ArrowUpRight aria-hidden="true" />
      </div>
      <div className="tournament-card__name">
        <h3>{tournament.name}</h3>
        <span>{tournament.allowedSymbols.map((symbol) => symbol.split('-')[0]).join(' · ')}</span>
      </div>
      <div className="tournament-card__pool">
        <span>Prize pool</span>
        <strong key={tournament.currentPrizePool} className="live-number">
          {formatCompactUsd(tournament.currentPrizePool)}
        </strong>
        <small>Enter with {formatCompactUsd(tournament.newEntryBankroll)}</small>
      </div>
      <div className="tournament-card__meta">
        <div>
          <UsersRound aria-hidden="true" />
          <span>{tournament.totalEntries} entries</span>
        </div>
        <div>
          <Timer aria-hidden="true" />
          <Countdown
            endsAt={
              tournament.status === 'OPEN' ? tournament.entryClosesAt : tournament.tradingClosesAt
            }
            prefix={tournament.status === 'OPEN' ? 'Entry' : 'Trading'}
          />
        </div>
      </div>
      <div className="tournament-card__contribution">
        <span>Simulated contribution</span>
        <strong>{formatUsd(tournament.entryContribution)}</strong>
      </div>
    </Link>
  );
}
