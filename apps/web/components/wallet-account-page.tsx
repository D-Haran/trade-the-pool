'use client';

import { Check, KeyRound, Link2, Star, Trash2, Unplug } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiClientError } from '@/lib/api-client';
import { queryKeys } from '@/lib/query-keys';
import { AuthGuard } from './auth-guard';
import { abbreviateWallet, WalletIdentityActions } from './wallet-identity-actions';
import { Button } from './ui/button';
import { EmptyState, ErrorState, LoadingState } from './ui/states';

export function WalletAccountPage() {
  const queryClient = useQueryClient();
  const wallets = useQuery({ queryKey: queryKeys.wallets, queryFn: api.wallets });
  const unlink = useMutation({
    mutationFn: api.unlinkWallet,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.wallets }),
  });
  const makePrimary = useMutation({
    mutationFn: api.makePrimaryWallet,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.wallets }),
  });
  const actionError = unlink.error ?? makePrimary.error;

  return (
    <AuthGuard>
      <div className="wallet-account-page content-width">
        <header className="wallet-account-header">
          <span className="eyebrow">
            <span /> Account security
          </span>
          <h1>Wallet identity</h1>
          <p>
            Wallets prove who you are. Trading records and authorization remain attached to your
            Trade the Pool user ID.
          </p>
        </header>

        <div className="wallet-account-grid">
          <section className="wallet-card">
            <div className="wallet-card__heading">
              <div>
                <small>Browser connection</small>
                <h2>Connected wallet</h2>
              </div>
              <Unplug aria-hidden="true" />
            </div>
            <WalletIdentityActions
              mode="link"
              onSuccess={() => queryClient.invalidateQueries({ queryKey: queryKeys.wallets })}
            />
            <p className="wallet-separation-note">
              Disconnecting here does not log you out and does not unlink the wallet from your
              account.
            </p>
          </section>

          <section className="wallet-card wallet-card--wide">
            <div className="wallet-card__heading">
              <div>
                <small>Application identity</small>
                <h2>Linked wallets</h2>
              </div>
              <KeyRound aria-hidden="true" />
            </div>
            {wallets.isLoading ? <LoadingState label="Loading linked wallets" /> : null}
            {wallets.isError ? (
              <ErrorState title="Unable to load wallets" retry={() => wallets.refetch()} />
            ) : null}
            {wallets.data?.data.length === 0 ? (
              <EmptyState
                title="No wallet linked"
                detail="Connect a wallet and sign a link challenge to add your first wallet."
              />
            ) : null}
            <div className="linked-wallet-list">
              {wallets.data?.data.map((wallet) => (
                <article key={wallet.id} className="linked-wallet-row">
                  <span className="linked-wallet-row__icon">
                    {wallet.isPrimary ? <Star aria-hidden="true" /> : <Link2 aria-hidden="true" />}
                  </span>
                  <div>
                    <strong className="tabular">{abbreviateWallet(wallet.address)}</strong>
                    <small>
                      Solana · {wallet.network}
                      {wallet.isPrimary ? ' · Primary' : ''}
                    </small>
                  </div>
                  <div className="linked-wallet-row__actions">
                    {!wallet.isPrimary ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={makePrimary.isPending}
                        onClick={() => makePrimary.mutate(wallet.id)}
                      >
                        <Check aria-hidden="true" /> Make primary
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={unlink.isPending}
                      onClick={() => {
                        if (window.confirm('Unlink this wallet from your application account?'))
                          unlink.mutate(wallet.id);
                      }}
                    >
                      <Trash2 aria-hidden="true" /> Unlink
                    </Button>
                  </div>
                </article>
              ))}
            </div>
            {actionError ? (
              <p className="form-error" role="alert">
                {actionError instanceof ApiClientError
                  ? actionError.message
                  : 'The wallet change could not be completed.'}
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </AuthGuard>
  );
}
