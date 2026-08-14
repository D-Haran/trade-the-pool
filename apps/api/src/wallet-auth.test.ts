import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { MemoryKeyValueStore } from './infrastructure.js';
import {
  WalletAuthenticationService,
  canonicalSolanaAddress,
  verifyWalletSignature,
  walletChallengeKey,
} from './wallet-auth.js';

const config = {
  enabled: true,
  cluster: 'devnet' as const,
  domain: 'localhost:3000',
  origin: 'http://localhost:3000',
  challengeTtlSeconds: 300,
};
const browser = { browserBinding: 'browser-a' };

function signer() {
  const keys = nacl.sign.keyPair();
  return { keys, address: bs58.encode(keys.publicKey) };
}

function proof(
  challenge: { challengeId: string; message: string },
  wallet: ReturnType<typeof signer>,
  message = challenge.message,
) {
  const bytes = Buffer.from(message, 'utf8');
  return {
    challengeId: challenge.challengeId,
    address: wallet.address,
    signedMessage: bytes.toString('base64'),
    signature: Buffer.from(nacl.sign.detached(bytes, wallet.keys.secretKey)).toString('base64'),
  };
}

describe('Solana wallet proof validation', () => {
  it('accepts a valid exact-message signature and consumes the challenge', async () => {
    const store = new MemoryKeyValueStore();
    const service = new WalletAuthenticationService(null as never, store, config);
    const wallet = signer();
    const challenge = await service.issueChallenge('LOGIN', wallet.address, browser);
    await expect(
      service.verifyChallenge('LOGIN', proof(challenge, wallet), browser),
    ).resolves.toEqual({
      address: wallet.address,
      network: 'devnet',
    });
    await expect(
      service.verifyChallenge('LOGIN', proof(challenge, wallet), browser),
    ).rejects.toMatchObject({ code: 'WALLET_CHALLENGE_INVALID' });
  });

  it('rejects modified messages, wrong wallets, and invalid signatures', async () => {
    const service = new WalletAuthenticationService(
      null as never,
      new MemoryKeyValueStore(),
      config,
    );
    const wallet = signer();
    const modified = await service.issueChallenge('LOGIN', wallet.address, browser);
    await expect(
      service.verifyChallenge(
        'LOGIN',
        proof(modified, wallet, `${modified.message}\nchanged`),
        browser,
      ),
    ).rejects.toMatchObject({ code: 'WALLET_SIGNATURE_INVALID' });

    const wrongWallet = signer();
    const wrong = await service.issueChallenge('LOGIN', wallet.address, browser);
    await expect(
      service.verifyChallenge(
        'LOGIN',
        { ...proof(wrong, wrongWallet), address: wallet.address },
        browser,
      ),
    ).rejects.toMatchObject({ code: 'WALLET_SIGNATURE_INVALID' });

    const invalid = await service.issueChallenge('LOGIN', wallet.address, browser);
    const invalidProof = proof(invalid, wallet);
    invalidProof.signature = Buffer.alloc(64).toString('base64');
    await expect(service.verifyChallenge('LOGIN', invalidProof, browser)).rejects.toMatchObject({
      code: 'WALLET_SIGNATURE_INVALID',
    });
  });

  it('rejects expired, purpose-swapped, and session-rebound challenges', async () => {
    const store = new MemoryKeyValueStore();
    const service = new WalletAuthenticationService(null as never, store, config);
    const wallet = signer();
    const expired = await service.issueChallenge('LOGIN', wallet.address, browser);
    const state = JSON.parse((await store.get(walletChallengeKey(expired.challengeId)))!) as {
      input: { expirationTime: string };
    };
    state.input.expirationTime = new Date(0).toISOString();
    await store.set(walletChallengeKey(expired.challengeId), JSON.stringify(state));
    await expect(
      service.verifyChallenge('LOGIN', proof(expired, wallet), browser),
    ).rejects.toMatchObject({
      code: 'WALLET_CHALLENGE_EXPIRED',
    });

    const linked = await service.issueChallenge('LINK', wallet.address, {
      browserBinding: 'browser-a',
      userId: '10000000-0000-4000-8000-000000000001',
      sessionId: 'session-a',
    });
    await expect(
      service.verifyChallenge('LOGIN', proof(linked, wallet), browser),
    ).rejects.toMatchObject({ code: 'WALLET_CHALLENGE_INVALID' });

    const rebound = await service.issueChallenge('LINK', wallet.address, {
      browserBinding: 'browser-a',
      userId: '10000000-0000-4000-8000-000000000001',
      sessionId: 'session-a',
    });
    await expect(
      service.verifyChallenge('LINK', proof(rebound, wallet), {
        browserBinding: 'browser-a',
        userId: '10000000-0000-4000-8000-000000000001',
        sessionId: 'session-b',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_CHALLENGE_INVALID' });

    const crossBrowser = await service.issueChallenge('LOGIN', wallet.address, browser);
    await expect(
      service.verifyChallenge('LOGIN', proof(crossBrowser, wallet), {
        browserBinding: 'browser-b',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_CHALLENGE_INVALID' });
  });

  it('strictly validates canonical addresses and base64 signatures', () => {
    expect(() => canonicalSolanaAddress('not-a-solana-address')).toThrow();
    const wallet = signer();
    const message = 'message';
    expect(() =>
      verifyWalletSignature(
        wallet.address,
        message,
        Buffer.from(message).toString('base64'),
        'not-base64',
      ),
    ).toThrow();
  });
});
