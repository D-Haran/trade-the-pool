'use client';

import type {
  EntryDetailDto,
  EntrySummaryDto,
  LeaderboardPageDto,
  PositionDto,
  TournamentDto,
} from '@trade-the-pool/shared';
import { ArrowDown, ArrowUp, ChevronDown, Clock3 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { formatPercent, formatUsd, isPositive } from '@/lib/format';
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
  const previousRank = useRef(account.rank);
  const [rankDelta, setRankDelta] = useState(0);
  useEffect(() => {
    if (previousRank.current && account.rank && previousRank.current !== account.rank) {
      setRankDelta(previousRank.current - account.rank);
      const timer = window.setTimeout(() => setRankDelta(0), 4_000);
      previousRank.current = account.rank;
      return () => window.clearTimeout(timer);
    }
    previousRank.current = account.rank;
  }, [account.rank]);
  const projectedPrize = tournament?.payoutProjection.prizes.find(
    (prize) => prize.position === account.rank,
  )?.amount;
  const podiumScore = leaderboard?.data.find((row) => row.rank === 3)?.score;
  const podiumGap = podiumScore ? subtractMoney(podiumScore, account.score) : null;
  const cashLine = tournament?.payoutProjection.cashLinePosition ?? 0;
  const cashLineScore = leaderboard?.data.find((row) => row.rank === cashLine)?.score;
  const cashGap = cashLineScore ? subtractMoney(cashLineScore, account.score) : null;
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
          <dd className={cn('tabular rank-feedback', rankDelta && 'is-changing')}>
            {account.rank ? `#${account.rank}` : '—'}
            {rankDelta ? (
              <span className={rankDelta > 0 ? 'positive' : 'negative'}>
                {rankDelta > 0 ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
                {Math.abs(rankDelta)}
              </span>
            ) : null}
          </dd>
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
            {cashLine
              ? account.rank && account.rank <= cashLine
                ? `#${cashLine} · IN CASH`
                : cashGap && !cashGap.startsWith('-')
                  ? `${formatUsd(cashGap, { signed: true })} TO CASH`
                  : `#${cashLine}`
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

export function AccountStrip({
  account,
  activePosition,
}: {
  account: EntryDetailDto;
  activePosition: PositionDto | null;
}) {
  const exposure =
    Number(account.equity) > 0 ? Number(account.grossExposure) / Number(account.equity) : 0;
  return (
    <dl className="terminal-account-strip">
      <div className="account-metric account-metric--hero">
        <dt>TOTAL P&amp;L</dt>
        <dd
          className={cn(
            'tabular',
            account.score.startsWith('-') ? 'negative' : isPositive(account.score) && 'positive',
          )}
        >
          <strong>{formatUsd(account.score, { signed: true })}</strong>
          <span>{formatPercent(account.percentageReturn)}</span>
        </dd>
      </div>
      <div className="account-metric account-metric--primary">
        <dt>SIMULATED EQUITY</dt>
        <dd className="tabular">{formatUsd(account.equity)}</dd>
      </div>
      {activePosition ? (
        <div className="account-metric account-metric--position">
          <dt>
            {activePosition.symbol.replace('-', '/')} · {activePosition.side}{' '}
            {activePosition.leverage}x
          </dt>
          <dd
            className={cn(
              'tabular',
              activePosition.unrealizedPnL.startsWith('-')
                ? 'negative'
                : isPositive(activePosition.unrealizedPnL) && 'positive',
            )}
          >
            <strong>{formatUsd(activePosition.unrealizedPnL, { signed: true })}</strong>
            <span>{formatPercent(activePosition.percentageReturn)} ROI</span>
          </dd>
        </div>
      ) : null}
      <div className="account-metric account-metric--primary">
        <dt>ACCOUNT EXPOSURE</dt>
        <dd className="tabular">{exposure.toFixed(2)}x</dd>
      </div>
      <div className="account-metric account-metric--secondary">
        <dt>AVAILABLE MARGIN</dt>
        <dd className="tabular">{formatUsd(account.availableMargin)}</dd>
      </div>
      <div className="account-metric account-metric--secondary">
        <dt>MARGIN USED</dt>
        <dd className="tabular">{formatUsd(account.marginUsed)}</dd>
      </div>
      <div className="account-metric account-metric--tertiary">
        <dt>GROSS EXPOSURE</dt>
        <dd className="tabular">{formatUsd(account.grossExposure)}</dd>
      </div>
      <div className="account-metric account-metric--tertiary">
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
      <div className="account-metric account-metric--tertiary">
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
      <div className="account-metric account-metric--tertiary">
        <dt>STARTING BANKROLL</dt>
        <dd className="tabular">{formatUsd(account.startingBankroll)}</dd>
      </div>
    </dl>
  );
}
