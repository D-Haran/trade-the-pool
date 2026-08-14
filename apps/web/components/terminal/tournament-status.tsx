'use client';

import type {
  EntryDetailDto,
  EntrySummaryDto,
  LeaderboardPageDto,
  TournamentDto,
} from '@trade-the-pool/shared';
import { ChevronDown, Clock3 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatUsd, isPositive } from '@/lib/format';
import { Countdown } from '../countdown';

function subtractMoney(left: string, right: string): string {
  const cents = (value: string) => {
    const sign = value.startsWith('-') ? -1n : 1n;
    const [whole, fraction = ''] = (sign < 0n ? value.slice(1) : value).split('.');
    return sign * (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
  };
  const result = cents(left) - cents(right);
  const sign = result < 0n ? '-' : '';
  const absolute = result < 0n ? -result : result;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

export function TournamentStatus({
  account,
  tournament,
  entries,
  leaderboard,
  switching,
  onSwitch,
  onExpire,
}: {
  account: EntryDetailDto;
  tournament?: TournamentDto;
  entries: EntrySummaryDto[];
  leaderboard?: LeaderboardPageDto;
  switching: boolean;
  onSwitch: (entry: EntrySummaryDto) => void;
  onExpire: () => void;
}) {
  const projectedPrize = tournament?.payoutProjection.prizes.find(
    (prize) => prize.position === account.rank,
  )?.amount;
  const podiumScore = leaderboard?.data.find((row) => row.rank === 3)?.score;
  const podiumGap = podiumScore ? subtractMoney(podiumScore, account.score) : null;
  return (
    <div className="terminal-tournament-bar">
      <div className="terminal-entry-switcher">
        <div>
          <span>{account.tournament.name}</span>
          <strong>ENTRY #{account.sequenceNumber} · PAPER</strong>
        </div>
        <label>
          <select
            value={account.id}
            disabled={switching || !entries.length}
            onChange={(event) => {
              const selected = entries.find((entry) => entry.id === event.target.value);
              if (selected) onSwitch(selected);
            }}
            aria-label="Active tournament entry"
          >
            {(entries.length ? entries : [account]).map((entry) => (
              <option key={entry.id} value={entry.id}>
                Entry #{entry.sequenceNumber} · {formatUsd(entry.score, { signed: true })}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" />
        </label>
      </div>
      <dl className="tournament-metrics">
        <div>
          <dt>RANK</dt>
          <dd className="tabular">{account.rank ? `#${account.rank}` : '—'}</dd>
        </div>
        <div>
          <dt>TOURNAMENT P&amp;L</dt>
          <dd
            className={cn(
              'tabular',
              account.score.startsWith('-') ? 'negative' : isPositive(account.score) && 'positive',
            )}
          >
            {formatUsd(account.score, { signed: true })}
          </dd>
        </div>
        <div>
          <dt>PRIZE POOL</dt>
          <dd className="tabular">{tournament ? formatUsd(tournament.currentPrizePool) : '—'}</dd>
        </div>
        <div>
          <dt>PROJECTED PRIZE</dt>
          <dd className="tabular">{projectedPrize ? formatUsd(projectedPrize) : '—'}</dd>
        </div>
        <div>
          <dt>PODIUM GAP</dt>
          <dd className="tabular">
            {podiumGap && !podiumGap.startsWith('-')
              ? formatUsd(podiumGap, { signed: true })
              : account.rank && account.rank <= 3
                ? 'IN PODIUM'
                : '—'}
          </dd>
        </div>
        <div>
          <dt>CASH LINE</dt>
          <dd className="tabular">
            {tournament?.payoutProjection.cashLinePosition
              ? `#${tournament.payoutProjection.cashLinePosition}`
              : '—'}
          </dd>
        </div>
      </dl>
      <div className="terminal-close-time">
        <Clock3 aria-hidden="true" />
        <span>TRADING CLOSES</span>
        <Countdown endsAt={account.tournament.tradingClosesAt} onExpire={onExpire} />
      </div>
    </div>
  );
}

export function AccountStrip({ account }: { account: EntryDetailDto }) {
  return (
    <dl className="terminal-account-strip">
      <div>
        <dt>SIMULATED EQUITY</dt>
        <dd className="tabular">{formatUsd(account.equity)}</dd>
      </div>
      <div>
        <dt>AVAILABLE BUYING POWER</dt>
        <dd className="tabular">{formatUsd(account.availableBuyingPower)}</dd>
      </div>
      <div>
        <dt>POSITION VALUE</dt>
        <dd className="tabular">{formatUsd(account.positionValue)}</dd>
      </div>
      <div>
        <dt>REALIZED P&amp;L</dt>
        <dd
          className={cn(
            'tabular',
            account.realizedPnL.startsWith('-')
              ? 'negative'
              : isPositive(account.realizedPnL) && 'positive',
          )}
        >
          {formatUsd(account.realizedPnL, { signed: true })}
        </dd>
      </div>
      <div>
        <dt>UNREALIZED P&amp;L</dt>
        <dd
          className={cn(
            'tabular',
            account.unrealizedPnL.startsWith('-')
              ? 'negative'
              : isPositive(account.unrealizedPnL) && 'positive',
          )}
        >
          {formatUsd(account.unrealizedPnL, { signed: true })}
        </dd>
      </div>
      <div>
        <dt>STARTING BANKROLL</dt>
        <dd className="tabular">{formatUsd(account.startingBankroll)}</dd>
      </div>
    </dl>
  );
}
