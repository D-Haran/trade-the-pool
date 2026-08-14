'use client';

import { ArrowRight, BarChart3, CircleDollarSign, Trophy } from 'lucide-react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { formatCompactUsd, formatDate } from '@/lib/format';
import { ErrorState, LoadingState } from './ui/states';

export function HomePage() {
  const tournaments = useQuery({
    queryKey: queryKeys.tournaments(),
    queryFn: () => api.tournaments(),
  });
  const featured = tournaments.data?.data.find((item) => item.status === 'OPEN');
  return (
    <>
      <section className="hero content-width">
        <div className="hero__copy">
          <div className="eyebrow">
            <span /> Competitive paper trading
          </div>
          <h1>
            Trade the pool.
            <br />
            <span>Prove your edge.</span>
          </h1>
          <p>
            Your simulated bankroll grows with the prize pool. Enter later with more capital, or
            enter earlier with more time to trade. Highest dollar P&amp;L leads.
          </p>
          <div className="hero__actions">
            <Link className="button button--primary button--lg" href="/tournaments">
              Browse tournaments <ArrowRight aria-hidden="true" />
            </Link>
            <Link className="button button--secondary button--lg" href="/dashboard">
              View my entries
            </Link>
          </div>
          <div className="alpha-note">
            <span>ALPHA</span> Simulated funds. Competition testing only.
          </div>
        </div>
        <div className="hero__market" aria-label="Featured tournament">
          {tournaments.isLoading ? <LoadingState label="Finding an open tournament" /> : null}
          {tournaments.isError ? <ErrorState retry={() => tournaments.refetch()} /> : null}
          {featured ? (
            <Link href={`/tournaments/${featured.slug}`} className="featured-pool">
              <div className="featured-pool__top">
                <span className="live-indicator">
                  <i /> Live
                </span>
                <span>{featured.totalEntries} entries</span>
              </div>
              <div className="featured-pool__name">{featured.name}</div>
              <div className="featured-pool__value">
                <span>Prize pool</span>
                <strong key={featured.currentPrizePool} className="live-number">
                  {formatCompactUsd(featured.currentPrizePool)}
                </strong>
                <small>
                  Enter now with {formatCompactUsd(featured.newEntryBankroll)} simulated
                </small>
              </div>
              <div className="featured-pool__footer">
                <span>Trading closes</span>
                <strong>{formatDate(featured.tradingClosesAt)}</strong>
                <ArrowRight aria-hidden="true" />
              </div>
            </Link>
          ) : null}
        </div>
      </section>

      <section className="mechanic content-width" aria-labelledby="mechanic-title">
        <div className="section-heading">
          <span className="eyebrow">One pool. Equal markets.</span>
          <h2 id="mechanic-title">A competition built around P&amp;L.</h2>
        </div>
        <div className="mechanic-grid">
          {[
            {
              n: '01',
              icon: CircleDollarSign,
              title: 'Enter the tournament',
              text: 'Your simulated bankroll is the base plus the prize pool at entry creation, then locks permanently.',
            },
            {
              n: '02',
              icon: BarChart3,
              title: 'Trade the market',
              text: 'Build long-only positions in BTC, ETH, and SOL with deterministic market execution.',
            },
            {
              n: '03',
              icon: Trophy,
              title: 'Climb by dollar P&L',
              text: 'Rank is based on exact dollar profit and loss—not percentage return or account size.',
            },
          ].map(({ n, icon: Icon, title, text }) => (
            <article key={n} className="mechanic-card">
              <div>
                <Icon aria-hidden="true" />
                <span>{n}</span>
              </div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
