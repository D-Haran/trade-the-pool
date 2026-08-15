'use client';

import type { ApiEnvelope, TournamentDto } from '@trade-the-pool/shared';
import { ArrowRight, CheckCircle2, ShieldCheck, Swords, Timer, UsersRound } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiClientError, type CreatedEntryDto } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatDate, formatUsd, isPositive } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { statusLabel } from '@/lib/tournaments';
import { useRealtime } from '@/hooks/use-realtime';
import { Button } from './ui/button';
import { Countdown } from './countdown';
import { Leaderboard } from './leaderboard';
import { ErrorState, LoadingState } from './ui/states';

function entryError(error: unknown): string {
  if (!(error instanceof ApiClientError)) return 'The entry could not be created.';
  const messages: Record<string, string> = {
    ENTRY_LIMIT_REACHED: 'You have reached the entry limit for this tournament.',
    ENTRY_CLOSED: 'The entry window has closed.',
    TOURNAMENT_NOT_OPEN: 'This tournament is not accepting entries.',
    REGISTRATION_NOT_OPEN: 'Registration has not opened yet.',
    RATE_LIMITED: 'Entry creation is temporarily rate limited. Please wait before trying again.',
    AUTHENTICATION_REQUIRED: 'Your session expired. Sign in again to create an entry.',
  };
  return messages[error.code] ?? error.message;
}

export function TournamentDetail({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState<CreatedEntryDto | null>(null);
  const session = useQuery({ queryKey: queryKeys.session, queryFn: api.session, retry: false });
  const tournament = useQuery({
    queryKey: queryKeys.tournament(slug),
    queryFn: () => api.tournament(slug),
  });
  const tournamentId = tournament.data?.data.id;
  const entriesQuery = `pageSize=100${tournamentId ? `&tournamentId=${tournamentId}` : ''}`;
  const entries = useQuery({
    queryKey: queryKeys.entries(entriesQuery),
    queryFn: () => api.entries(entriesQuery),
    enabled: Boolean(session.data && tournamentId),
    retry: false,
  });
  const leaderboard = useQuery({
    queryKey: queryKeys.leaderboard(tournamentId ?? 'pending'),
    queryFn: () => api.leaderboard(tournamentId!),
    enabled: Boolean(tournamentId),
  });
  const topics = useMemo(
    () => (tournamentId ? [`tournament:${tournamentId}`] : []),
    [tournamentId],
  );
  useRealtime(
    topics,
    (event) => {
      if (!tournamentId) return;
      if (event.type === 'tournament.prize_pool_updated') {
        queryClient.setQueryData<ApiEnvelope<TournamentDto>>(
          queryKeys.tournament(slug),
          (current) =>
            current
              ? {
                  data: {
                    ...current.data,
                    currentPrizePool: event.currentPrizePool,
                    newEntryBankroll: event.newEntryBankroll,
                    currentEntryPrice: event.currentEntryPrice,
                    totalEntries: event.totalEntries,
                  },
                }
              : current,
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.tournament(slug) });
      }
      if (event.type === 'tournament.status_changed')
        void queryClient.invalidateQueries({ queryKey: queryKeys.tournament(slug) });
      if (event.type === 'leaderboard.updated')
        void queryClient.invalidateQueries({ queryKey: queryKeys.leaderboard(tournamentId) });
    },
    () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tournament(slug) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.leaderboard(tournamentId ?? 'pending'),
      });
    },
  );
  const create = useMutation({
    mutationFn: () => api.createEntry(tournamentId!),
    onSuccess: async ({ data }) => {
      setConfirmation(data);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tournament(slug) }),
        queryClient.invalidateQueries({ queryKey: ['entries'] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.leaderboard(tournamentId!) }),
        queryClient.invalidateQueries({ queryKey: ['tournaments'] }),
      ]);
    },
  });
  if (tournament.isLoading) return <LoadingState label="Loading tournament" />;
  if (tournament.isError || !tournament.data)
    return (
      <div className="page content-width">
        <ErrorState title="Tournament unavailable" retry={() => tournament.refetch()} />
      </div>
    );
  const item = tournament.data.data;
  const owned = entries.data?.data ?? [];
  const canEnter = item.eligibleToEnter === true && !create.isPending;
  const final = item.status === 'COMPLETED';
  const payoutForRank = (rank: number | null) =>
    rank
      ? item.payoutProjection.prizes.find((prize) => prize.position === rank)?.amount
      : undefined;
  return (
    <div className="detail-page">
      <section className="detail-hero content-width">
        <div className="detail-hero__heading">
          <span className={`status-badge status-badge--${item.status.toLowerCase()}`}>
            {statusLabel(item.status)}
          </span>
          <h1>{item.name}</h1>
          <p>{item.description}</p>
          <div className="market-pills">
            {item.allowedSymbols.map((symbol) => (
              <span key={symbol}>{symbol.replace('-', '/')}</span>
            ))}
          </div>
        </div>
        <div className="pool-mechanic">
          <div className="pool-mechanic__result">
            <span>Enter now with</span>
            <strong key={item.newEntryBankroll} className="tabular live-number">
              {formatUsd(item.newEntryBankroll)}
            </strong>
            <small>
              {formatUsd(item.baseBankroll)} base + {formatUsd(item.currentPrizePool)} prize pool
            </small>
          </div>
          <div className="pool-mechanic__stat pool-mechanic__stat--prize">
            <span>Prize pool</span>
            <strong key={item.currentPrizePool} className="tabular live-number">
              {formatUsd(item.currentPrizePool)}
            </strong>
          </div>
          <div className="pool-mechanic__stat">
            <span>Entry fee</span>
            <strong className="tabular">{formatUsd(item.currentEntryPrice)}</strong>
          </div>
          <p>
            Your starting bankroll locks when the server creates the entry. Future prize-pool growth
            does not change it.
          </p>
        </div>
      </section>

      <div className="detail-grid content-width">
        <div className="detail-main">
          {entries.isError ? (
            <ErrorState
              title="Your entries are unavailable"
              detail="The trading accounts could not be valued with authoritative market data."
              retry={() => entries.refetch()}
            />
          ) : null}
          {confirmation ? (
            <section className="entry-confirmation" role="status">
              <CheckCircle2 aria-hidden="true" />
              <div>
                <span>Entry #{confirmation.sequenceNumber} created</span>
                <strong>
                  Locked starting bankroll{' '}
                  <b className="tabular">{formatUsd(confirmation.startingBankroll)}</b>
                </strong>
                <small>Current prize pool {formatUsd(confirmation.currentPrizePool)}</small>
                <small>Entry price locked at {formatUsd(confirmation.entryFee)}</small>
              </div>
              <Link
                className="button button--primary button--md"
                href={`/tournaments/${item.slug}/trade/${confirmation.id}`}
              >
                Open terminal <ArrowRight aria-hidden="true" />
              </Link>
            </section>
          ) : null}
          {owned.length ? (
            <section className="detail-section">
              <div className="detail-section__title">
                <div>
                  <span>Your entries</span>
                  <h2>Choose an account</h2>
                </div>
                <small>
                  {owned.length} of {item.maxEntriesPerUser}
                </small>
              </div>
              <div className="owned-entry-grid">
                {owned.map((entry) => {
                  const payout = payoutForRank(entry.rank);
                  return (
                    <Link
                      key={entry.id}
                      href={`/tournaments/${item.slug}/trade/${entry.id}`}
                      className="owned-entry"
                    >
                      <div className="owned-entry__head">
                        <strong>Entry #{entry.sequenceNumber}</strong>
                        <ArrowRight aria-hidden="true" />
                      </div>
                      <div className="owned-entry__bankroll">
                        <span>Current bankroll</span>
                        <strong className="tabular">{formatUsd(entry.equity)}</strong>
                      </div>
                      <div className="owned-entry__performance">
                        <span>
                          P&amp;L
                          <b
                            className={cn(
                              'tabular',
                              entry.score.startsWith('-')
                                ? 'negative'
                                : isPositive(entry.score) && 'positive',
                            )}
                          >
                            {formatUsd(entry.score, { signed: true })}
                          </b>
                        </span>
                        <span>
                          Rank <b className="tabular">{entry.rank ? `#${entry.rank}` : '—'}</b>
                        </span>
                      </div>
                      <div className="owned-entry__status">
                        {payout ? (
                          <>
                            <span>Current payout</span>
                            <b className="tabular">{formatUsd(payout)}</b>
                          </>
                        ) : entry.rank && entry.rank <= item.payoutProjection.cashLinePosition ? (
                          <span>In the money</span>
                        ) : (
                          <span>Open terminal</span>
                        )}
                      </div>
                      <small>
                        Started with {formatUsd(entry.startingBankroll)} · Entry fee{' '}
                        {formatUsd(entry.entryFee)}
                      </small>
                    </Link>
                  );
                })}
              </div>
            </section>
          ) : null}
          <section className="detail-section payout-section">
            <div className="detail-section__title">
              <div>
                <span>Projected distribution</span>
                <h2>Prizes</h2>
              </div>
              <small>Top {item.payoutProjection.cashLinePosition} get paid</small>
            </div>
            <div className="payout-grid">
              <div>
                <span>1st</span>
                <strong className="tabular">{formatUsd(item.payoutProjection.firstPrize)}</strong>
              </div>
              <div>
                <span>2nd</span>
                <strong className="tabular">{formatUsd(item.payoutProjection.secondPrize)}</strong>
              </div>
              <div>
                <span>3rd</span>
                <strong className="tabular">{formatUsd(item.payoutProjection.thirdPrize)}</strong>
              </div>
              <div>
                <span>Payout status</span>
                <strong>Top {item.payoutProjection.cashLinePosition} paid</strong>
              </div>
            </div>
          </section>
          <section className="detail-section" id="leaderboard">
            <div className="detail-section__title">
              <div>
                <span>{final ? 'Final standings' : 'Live standings'}</span>
                <h2>{final ? 'Final Results' : 'Leaderboard'}</h2>
              </div>
            </div>
            {leaderboard.isLoading ? <LoadingState label="Loading standings" /> : null}
            {leaderboard.data ? <Leaderboard leaderboard={leaderboard.data} compact /> : null}
            {leaderboard.isError ? <ErrorState retry={() => leaderboard.refetch()} /> : null}
          </section>
          <section className="detail-section rules-section">
            <div className="detail-section__title">
              <div>
                <span>Competition format</span>
                <h2>Rules</h2>
              </div>
            </div>
            <div className="rules-grid">
              <div>
                <ShieldCheck aria-hidden="true" />
                <strong>Simulated bankroll</strong>
                <p>Each entry starts with the base bankroll plus the prize pool at creation.</p>
              </div>
              <div>
                <Swords aria-hidden="true" />
                <strong>Dollar P&amp;L wins</strong>
                <p>
                  Rank uses current equity minus locked starting bankroll. Highest dollar gain wins.
                </p>
              </div>
              <div>
                <Timer aria-hidden="true" />
                <strong>Bankrolls stay locked</strong>
                <p>Future prize-pool growth never changes an existing entry's starting bankroll.</p>
              </div>
              <div>
                <UsersRound aria-hidden="true" />
                <strong>Entries grow the prize pool</strong>
                <p>
                  The configured share of each fee increases the prize pool and the bankroll
                  available to the next entry.
                </p>
              </div>
            </div>
          </section>
        </div>

        <aside className="entry-panel">
          <div className="entry-panel__header">
            <span>Create entry</span>
            <UsersRound aria-hidden="true" />
          </div>
          <div className="entry-panel__metric entry-panel__metric--hero">
            <span>You enter with</span>
            <strong key={item.newEntryBankroll} className="tabular live-number">
              {formatUsd(item.newEntryBankroll)}
            </strong>
            <small>
              {formatUsd(item.baseBankroll)} base + {formatUsd(item.currentPrizePool)} prize pool
            </small>
          </div>
          <div className="entry-panel__row">
            <span>Entry fee</span>
            <b className="tabular">{formatUsd(item.currentEntryPrice)}</b>
          </div>
          <div className="entry-panel__row">
            <span>Prize pool</span>
            <b key={item.currentPrizePool} className="tabular live-number">
              {formatUsd(item.currentPrizePool)}
            </b>
          </div>
          <div className="entry-panel__row">
            <span>Prize-pool contribution</span>
            <b className="tabular">{formatUsd(item.prizePoolContribution)}</b>
          </div>
          <div className="entry-panel__row">
            <span>Platform allocation</span>
            <b className="tabular">{formatUsd(item.platformFee)}</b>
          </div>
          {item.nextEntryPrice ? (
            <p className="entry-tier-note">
              Entry rises to {formatUsd(item.nextEntryPrice.entryFee)} when the prize pool reaches{' '}
              {formatUsd(item.nextEntryPrice.prizePoolThreshold)}.
            </p>
          ) : null}
          <div className="entry-panel__row">
            <span>Your entries</span>
            <b className="tabular">
              {session.data
                ? entries.isError
                  ? 'Unavailable'
                  : `${owned.length} / ${item.maxEntriesPerUser}`
                : '—'}
            </b>
          </div>
          <div className="entry-panel__deadline">
            <span>Entries close</span>
            <Countdown endsAt={item.entryClosesAt} onExpire={() => tournament.refetch()} />
          </div>
          {session.data ? (
            <Button
              className="entry-panel__button"
              disabled={!canEnter}
              onClick={() => {
                setConfirmation(null);
                create.mutate();
              }}
            >
              {create.isPending
                ? 'Creating entry…'
                : item.eligibleToEnter
                  ? 'Create entry'
                  : 'Entry unavailable'}
            </Button>
          ) : session.isError ? (
            <Button className="entry-panel__button" disabled>
              Session check unavailable
            </Button>
          ) : item.status === 'REGISTRATION_OPEN' || item.status === 'TRADING_ACTIVE' ? (
            <Link
              className="button button--primary button--md entry-panel__button"
              href={`/login?returnTo=${encodeURIComponent(`/tournaments/${slug}`)}`}
            >
              Sign in to enter
            </Link>
          ) : (
            <Button className="entry-panel__button" disabled>
              Entry unavailable
            </Button>
          )}
          <p className="entry-panel__note">
            Your starting bankroll locks when the entry is created. Future pool growth does not
            change it.
          </p>
          {create.isError ? (
            <p className="form-error" role="alert">
              {entryError(create.error)}
            </p>
          ) : null}
          <div className="entry-panel__times">
            <span>
              Registration opens <b>{formatDate(item.registrationOpensAt)}</b>
            </span>
            <span>
              Trading starts <b>{formatDate(item.tradingStartsAt)}</b>
            </span>
            <span>
              Entry close <b>{formatDate(item.entryClosesAt)}</b>
            </span>
            <span>
              Trading close <b>{formatDate(item.tradingClosesAt)}</b>
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
