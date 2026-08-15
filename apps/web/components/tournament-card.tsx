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
        <span>
          {tournament.allowedSymbols
            .slice(0, 5)
            .map((symbol) => symbol.split('-')[0])
            .join(' · ')}
          {tournament.allowedSymbols.length > 5
            ? ` · +${tournament.allowedSymbols.length - 5}`
            : ''}
        </span>
      </div>
      <div className="tournament-card__pool">
        <span>Prize pool</span>
        <strong key={tournament.currentPrizePool} className="live-number">
          {formatCompactUsd(tournament.currentPrizePool)}
        </strong>
        <small>New entry bankroll {formatCompactUsd(tournament.newEntryBankroll)}</small>
        <div className="tournament-card__prizes">
          <span>1st {formatCompactUsd(tournament.payoutProjection.firstPrize)}</span>
          <span>2nd {formatCompactUsd(tournament.payoutProjection.secondPrize)}</span>
          <span>3rd {formatCompactUsd(tournament.payoutProjection.thirdPrize)}</span>
        </div>
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
              tournament.status === 'REGISTRATION_OPEN' || tournament.status === 'TRADING_ACTIVE'
                ? tournament.entryClosesAt
                : tournament.tradingClosesAt
            }
            prefix={
              tournament.status === 'REGISTRATION_OPEN' || tournament.status === 'TRADING_ACTIVE'
                ? 'Entry'
                : 'Trading'
            }
          />
        </div>
      </div>
      <div className="tournament-card__contribution">
        <span>Entry now</span>
        <strong>{formatUsd(tournament.currentEntryPrice)}</strong>
      </div>
    </Link>
  );
}
