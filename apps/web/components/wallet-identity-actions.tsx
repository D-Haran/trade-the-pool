'use client';

import { Link2, ShieldCheck, Unplug, Wallet } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { useWalletStandard } from '@/lib/wallet-standard';
import { Button } from './ui/button';

export function abbreviateWallet(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function WalletIdentityActions({
  mode,
  onSuccess,
}: {
  mode: 'login' | 'link';
  onSuccess: (data: unknown) => void;
}) {
  const wallet = useWalletStandard();
  const connect = useMutation({ mutationFn: wallet.connect });
  const authenticate = useMutation({
    mutationFn: async () => {
      if (!wallet.address) throw new Error('Connect a wallet before continuing.');
      const challenge =
        mode === 'login'
          ? await api.walletChallenge(wallet.address)
          : await api.walletLinkChallenge(wallet.address);
      const proof = await wallet.signChallenge(challenge.data);
      return mode === 'login' ? api.walletLogin(proof) : api.linkWallet(proof);
    },
    onSuccess,
  });
  const error = connect.error ?? authenticate.error;

  if (wallet.address)
    return (
      <div className="wallet-actions">
        <div className="connected-wallet">
          <span className="connected-wallet__icon">
            <Wallet aria-hidden="true" />
          </span>
          <span>
            <small>Connected in browser</small>
            <strong className="tabular">{abbreviateWallet(wallet.address)}</strong>
          </span>
          <button type="button" onClick={() => wallet.disconnect()} aria-label="Disconnect wallet">
            <Unplug aria-hidden="true" />
          </button>
        </div>
        <Button
          size="lg"
          className="wallet-primary-action"
          disabled={authenticate.isPending}
          onClick={() => authenticate.mutate()}
        >
          {mode === 'login' ? <ShieldCheck aria-hidden="true" /> : <Link2 aria-hidden="true" />}
          {authenticate.isPending
            ? 'Waiting for signature…'
            : mode === 'login'
              ? 'Sign in with wallet'
              : 'Link connected wallet'}
        </Button>
        <p className="wallet-proof-note">
          This signature proves ownership only. It does not create a transaction or transfer funds.
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error instanceof Error ? error.message : 'Wallet authentication failed.'}
          </p>
        ) : null}
      </div>
    );

  return (
    <div className="wallet-actions">
      {wallet.wallets.length ? (
        wallet.wallets.map((option) => (
          <Button
            key={option.name}
            variant="secondary"
            className="wallet-choice"
            disabled={wallet.connecting || connect.isPending}
            onClick={() => connect.mutate(option.name)}
          >
            <span className="wallet-choice__mark">
              <Wallet aria-hidden="true" />
            </span>
            <span>
              <strong>{option.name}</strong>
              <small>Wallet Standard</small>
            </span>
          </Button>
        ))
      ) : (
        <div className="wallet-empty">
          <Wallet aria-hidden="true" />
          <strong>No compatible Solana wallet detected</strong>
          <span>Install or open a Wallet Standard-compatible wallet, then refresh this page.</span>
        </div>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error instanceof Error ? error.message : 'Wallet connection failed.'}
        </p>
      ) : null}
    </div>
  );
}
