'use client';

import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardDisconnect,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
} from '@wallet-standard/features';
import {
  SolanaSignIn,
  SolanaSignMessage,
  type SolanaSignInFeature,
  type SolanaSignMessageFeature,
} from '@solana/wallet-standard-features';
import type { WalletChallengeDto } from '@trade-the-pool/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type WalletOption = { name: string; icon: string };
export type SignedWalletChallenge = {
  challengeId: string;
  address: string;
  signature: string;
  signedMessage: string;
};

type WalletState = {
  wallets: WalletOption[];
  selectedWalletName: string | null;
  address: string | null;
  connecting: boolean;
  connect(walletName: string): Promise<string>;
  disconnect(): Promise<void>;
  signChallenge(challenge: WalletChallengeDto): Promise<SignedWalletChallenge>;
};

const WalletContext = createContext<WalletState | null>(null);

function supportsSolanaIdentity(wallet: Wallet): boolean {
  return (
    StandardConnect in wallet.features &&
    (SolanaSignIn in wallet.features || SolanaSignMessage in wallet.features) &&
    wallet.chains.some((chain) => chain.startsWith('solana:'))
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function WalletStandardProvider({ children }: { children: ReactNode }) {
  const [registeredWallets, setRegisteredWallets] = useState<readonly Wallet[]>([]);
  const [selectedWallet, setSelectedWallet] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const registry = getWallets();
    const refresh = () => setRegisteredWallets(registry.get().filter(supportsSolanaIdentity));
    refresh();
    const unregisterAdded = registry.on('register', refresh);
    const unregisterRemoved = registry.on('unregister', refresh);
    return () => {
      unregisterAdded();
      unregisterRemoved();
    };
  }, []);

  const connect = useCallback(
    async (walletName: string) => {
      const wallet = registeredWallets.find((candidate) => candidate.name === walletName);
      if (!wallet || !supportsSolanaIdentity(wallet))
        throw new Error('The selected wallet is unavailable or does not support message signing.');
      setConnecting(true);
      try {
        const feature = wallet.features[
          StandardConnect
        ] as StandardConnectFeature[typeof StandardConnect];
        const result = await feature.connect();
        const nextAccount = result.accounts.find(
          (candidate) =>
            candidate.chains.some((chain) => chain.startsWith('solana:')) &&
            (candidate.features.includes(SolanaSignIn) ||
              candidate.features.includes(SolanaSignMessage)),
        );
        if (!nextAccount) throw new Error('The wallet did not provide a signable Solana account.');
        setSelectedWallet(wallet);
        setAccount(nextAccount);
        return nextAccount.address;
      } finally {
        setConnecting(false);
      }
    },
    [registeredWallets],
  );

  const disconnect = useCallback(async () => {
    const wallet = selectedWallet;
    setSelectedWallet(null);
    setAccount(null);
    if (wallet && StandardDisconnect in wallet.features) {
      const feature = wallet.features[
        StandardDisconnect
      ] as StandardDisconnectFeature[typeof StandardDisconnect];
      await feature.disconnect();
    }
  }, [selectedWallet]);

  const signChallenge = useCallback(
    async (challenge: WalletChallengeDto): Promise<SignedWalletChallenge> => {
      if (!selectedWallet || !account) throw new Error('Connect a wallet before signing in.');
      if (account.address !== challenge.input.address)
        throw new Error('The connected account does not match the server challenge.');
      if (SolanaSignIn in selectedWallet.features) {
        const feature = selectedWallet.features[
          SolanaSignIn
        ] as SolanaSignInFeature[typeof SolanaSignIn];
        const [output] = await feature.signIn(challenge.input);
        if (!output || output.account.address !== account.address)
          throw new Error('The wallet signed with an unexpected account.');
        return {
          challengeId: challenge.challengeId,
          address: output.account.address,
          signature: toBase64(output.signature),
          signedMessage: toBase64(output.signedMessage),
        };
      }
      if (!(SolanaSignMessage in selectedWallet.features))
        throw new Error('The selected wallet does not support message signing.');
      const feature = selectedWallet.features[
        SolanaSignMessage
      ] as SolanaSignMessageFeature[typeof SolanaSignMessage];
      const [output] = await feature.signMessage({
        account,
        message: new TextEncoder().encode(challenge.message),
      });
      if (!output) throw new Error('The wallet did not return a signature.');
      return {
        challengeId: challenge.challengeId,
        address: account.address,
        signature: toBase64(output.signature),
        signedMessage: toBase64(output.signedMessage),
      };
    },
    [account, selectedWallet],
  );

  const value = useMemo<WalletState>(
    () => ({
      wallets: registeredWallets.map((wallet) => ({ name: wallet.name, icon: wallet.icon })),
      selectedWalletName: selectedWallet?.name ?? null,
      address: account?.address ?? null,
      connecting,
      connect,
      disconnect,
      signChallenge,
    }),
    [
      account?.address,
      connect,
      connecting,
      disconnect,
      registeredWallets,
      selectedWallet?.name,
      signChallenge,
    ],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWalletStandard(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error('WalletStandardProvider is missing.');
  return value;
}
