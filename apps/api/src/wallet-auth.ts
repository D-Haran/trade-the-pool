import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { userWallets, users, type Database } from '@trade-the-pool/database';
import type {
  SolanaClusterDto,
  SolanaSignInInputDto,
  UserWalletDto,
  WalletChallengeDto,
  WalletChallengePurposeDto,
} from '@trade-the-pool/shared';
import { createSignInMessageText } from '@solana/wallet-standard-util';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { ApiError } from './errors.js';
import type { KeyValueStore } from './infrastructure.js';

const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const solanaClusterSchema = z.enum(['mainnet-beta', 'devnet', 'testnet', 'localnet']);
const challengeStateSchema = z
  .object({
    version: z.literal(1),
    purpose: z.enum(['LOGIN', 'LINK']),
    address: z.string(),
    chain: z.literal('SOLANA'),
    network: solanaClusterSchema,
    input: z.object({
      domain: z.string().min(1).max(255),
      address: z.string().min(32).max(44),
      statement: z.string(),
      uri: z.string().url(),
      version: z.literal('1'),
      chainId: z.enum(['solana:mainnet', 'solana:devnet', 'solana:testnet', 'solana:localnet']),
      nonce: z.string().regex(/^[0-9a-f]{32}$/),
      issuedAt: z.string().datetime(),
      expirationTime: z.string().datetime(),
      requestId: z.string().regex(CHALLENGE_ID_PATTERN),
    }),
    message: z.string(),
    userId: z.string().uuid().nullable(),
    sessionIdHash: z.string().nullable(),
    browserBindingHash: z.string().length(43),
  })
  .strict();

type ChallengeState = z.infer<typeof challengeStateSchema>;

export type WalletAuthConfig = {
  enabled: boolean;
  cluster: SolanaClusterDto;
  domain: string;
  origin: string;
  challengeTtlSeconds: number;
};

export type WalletProof = {
  challengeId: string;
  address: string;
  signature: string;
  signedMessage: string;
};

export const WALLET_FLOW_COOKIE = 'ttp_wallet_flow';

export function createWalletFlowBinding(): string {
  return randomBytes(32).toString('base64url');
}

function chainId(cluster: SolanaClusterDto): SolanaSignInInputDto['chainId'] {
  return `solana:${cluster === 'mainnet-beta' ? 'mainnet' : cluster}`;
}

function sessionHash(sessionId: string | undefined): string | null {
  return sessionId ? createHash('sha256').update(sessionId).digest('base64url') : null;
}

export function walletSubject(address: string): string {
  return createHash('sha256').update(address).digest('hex').slice(0, 24);
}

export function walletChallengeKey(id: string): string {
  return `wallet-challenge:${id}`;
}

export function canonicalSolanaAddress(value: string): {
  address: string;
  publicKey: Uint8Array;
} {
  let publicKey: Uint8Array;
  try {
    publicKey = bs58.decode(value);
  } catch {
    throw new ApiError(400, 'INVALID_REQUEST', 'A valid canonical Solana address is required.');
  }
  if (publicKey.length !== nacl.sign.publicKeyLength || bs58.encode(publicKey) !== value)
    throw new ApiError(400, 'INVALID_REQUEST', 'A valid canonical Solana address is required.');
  return { address: value, publicKey };
}

function decodeBase64(value: string, expectedLength?: number): Uint8Array {
  if (!value || value.length > 8192 || value.length % 4 !== 0 || !BASE64_PATTERN.test(value))
    throw new ApiError(400, 'INVALID_REQUEST', 'Wallet proof encoding is malformed.');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (expectedLength && decoded.length !== expectedLength))
    throw new ApiError(400, 'INVALID_REQUEST', 'Wallet proof encoding is malformed.');
  return decoded;
}

export function verifyWalletSignature(
  address: string,
  expectedMessage: string,
  signedMessageBase64: string,
  signatureBase64: string,
): void {
  const { publicKey } = canonicalSolanaAddress(address);
  const signedMessage = decodeBase64(signedMessageBase64);
  const expected = Buffer.from(expectedMessage, 'utf8');
  if (signedMessage.length !== expected.length || !Buffer.from(signedMessage).equals(expected))
    throw new ApiError(401, 'WALLET_SIGNATURE_INVALID', 'The signed wallet message is invalid.');
  const signature = decodeBase64(signatureBase64, nacl.sign.signatureLength);
  if (!nacl.sign.detached.verify(signedMessage, signature, publicKey))
    throw new ApiError(401, 'WALLET_SIGNATURE_INVALID', 'The wallet signature is invalid.');
}

function serializeWallet(wallet: typeof userWallets.$inferSelect): UserWalletDto {
  return {
    id: wallet.id,
    address: wallet.address,
    chain: wallet.chain,
    network: wallet.network,
    isPrimary: wallet.isPrimary,
    verifiedAt: wallet.verifiedAt.toISOString(),
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    ('code' in error ? error.code === '23505' : 'cause' in error && isUniqueViolation(error.cause)),
  );
}

export class WalletAuthenticationService {
  constructor(
    private readonly db: Database,
    private readonly store: KeyValueStore,
    private readonly config: WalletAuthConfig,
  ) {}

  assertEnabled(): void {
    if (!this.config.enabled)
      throw new ApiError(404, 'WALLET_AUTH_DISABLED', 'Wallet authentication is not enabled.');
  }

  async issueChallenge(
    purpose: WalletChallengePurposeDto,
    addressValue: string,
    binding: { browserBinding: string; userId?: string; sessionId?: string },
  ): Promise<WalletChallengeDto> {
    this.assertEnabled();
    const { address } = canonicalSolanaAddress(addressValue);
    if (purpose === 'LINK' && (!binding.userId || !binding.sessionId))
      throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
    const challengeId = randomBytes(32).toString('base64url');
    const issuedAt = new Date();
    const expirationTime = new Date(issuedAt.getTime() + this.config.challengeTtlSeconds * 1000);
    const input: SolanaSignInInputDto = {
      domain: this.config.domain,
      address,
      statement:
        purpose === 'LOGIN'
          ? 'Sign in to Trade the Pool. This proves wallet ownership only; it does not authorize a transaction or transfer funds.'
          : 'Link this wallet to your Trade the Pool account. This proves wallet ownership only; it does not authorize a transaction or transfer funds.',
      uri: this.config.origin,
      version: '1',
      chainId: chainId(this.config.cluster),
      nonce: randomBytes(16).toString('hex'),
      issuedAt: issuedAt.toISOString(),
      expirationTime: expirationTime.toISOString(),
      requestId: challengeId,
    };
    const message = createSignInMessageText(input);
    const state: ChallengeState = {
      version: 1,
      purpose,
      address,
      chain: 'SOLANA',
      network: this.config.cluster,
      input,
      message,
      userId: binding.userId ?? null,
      sessionIdHash: sessionHash(binding.sessionId),
      browserBindingHash: sessionHash(binding.browserBinding)!,
    };
    try {
      await this.store.set(
        walletChallengeKey(challengeId),
        JSON.stringify(state),
        this.config.challengeTtlSeconds,
      );
    } catch {
      throw new ApiError(
        503,
        'WALLET_AUTHENTICATION_UNAVAILABLE',
        'Wallet authentication is temporarily unavailable.',
      );
    }
    return {
      challengeId,
      purpose,
      chain: 'SOLANA',
      network: this.config.cluster,
      input,
      message,
    };
  }

  async verifyChallenge(
    expectedPurpose: WalletChallengePurposeDto,
    proof: WalletProof,
    binding: { browserBinding: string; userId?: string; sessionId?: string },
  ): Promise<{ address: string; network: SolanaClusterDto }> {
    this.assertEnabled();
    if (!CHALLENGE_ID_PATTERN.test(proof.challengeId))
      throw new ApiError(401, 'WALLET_CHALLENGE_INVALID', 'The wallet challenge is invalid.');
    let raw: string | null;
    try {
      // GETDEL is the replay boundary. Every verification attempt consumes the challenge so an
      // intercepted or repeatedly guessed proof can never become a second authentication event.
      raw = await this.store.getDelete(walletChallengeKey(proof.challengeId));
    } catch {
      throw new ApiError(
        503,
        'WALLET_AUTHENTICATION_UNAVAILABLE',
        'Wallet authentication is temporarily unavailable.',
      );
    }
    if (!raw)
      throw new ApiError(
        401,
        'WALLET_CHALLENGE_INVALID',
        'The wallet challenge is invalid, expired, or already used.',
      );
    let serialized: unknown;
    try {
      serialized = JSON.parse(raw) as unknown;
    } catch {
      throw new ApiError(401, 'WALLET_CHALLENGE_INVALID', 'The wallet challenge is invalid.');
    }
    const parsed = challengeStateSchema.safeParse(serialized);
    if (!parsed.success)
      throw new ApiError(401, 'WALLET_CHALLENGE_INVALID', 'The wallet challenge is invalid.');
    const state = parsed.data;
    if (Date.parse(state.input.expirationTime) <= Date.now())
      throw new ApiError(401, 'WALLET_CHALLENGE_EXPIRED', 'The wallet challenge has expired.');
    if (
      state.purpose !== expectedPurpose ||
      state.chain !== 'SOLANA' ||
      state.network !== this.config.cluster ||
      state.input.chainId !== chainId(this.config.cluster) ||
      state.input.domain !== this.config.domain ||
      state.input.uri !== this.config.origin ||
      state.input.requestId !== proof.challengeId ||
      state.message !== createSignInMessageText(state.input)
    )
      throw new ApiError(401, 'WALLET_CHALLENGE_INVALID', 'The wallet challenge is invalid.');
    if (
      state.address !== proof.address ||
      state.input.address !== proof.address ||
      state.userId !== (binding.userId ?? null) ||
      state.sessionIdHash !== sessionHash(binding.sessionId) ||
      state.browserBindingHash !== sessionHash(binding.browserBinding)
    )
      throw new ApiError(
        401,
        'WALLET_CHALLENGE_INVALID',
        'The wallet challenge binding is invalid.',
      );
    verifyWalletSignature(state.address, state.message, proof.signedMessage, proof.signature);
    return { address: state.address, network: state.network };
  }

  async resolveOrCreateUser(address: string, network: SolanaClusterDto): Promise<string> {
    const [existing] = await this.db
      .select({ userId: userWallets.userId })
      .from(userWallets)
      .where(eq(userWallets.address, address));
    if (existing) {
      await this.db
        .update(userWallets)
        .set({ verifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(userWallets.address, address));
      return existing.userId;
    }
    try {
      return await this.db.transaction(async (transaction) => {
        const [user] = await transaction
          .insert(users)
          .values({ displayName: `Trader ${address.slice(0, 4)}…${address.slice(-4)}` })
          .returning({ id: users.id });
        await transaction.insert(userWallets).values({
          userId: user!.id,
          address,
          chain: 'SOLANA',
          network,
          isPrimary: true,
          verifiedAt: new Date(),
        });
        return user!.id;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const [winner] = await this.db
        .select({ userId: userWallets.userId })
        .from(userWallets)
        .where(eq(userWallets.address, address));
      if (winner) return winner.userId;
      throw error;
    }
  }

  async link(userId: string, address: string, network: SolanaClusterDto): Promise<UserWalletDto> {
    try {
      const wallet = await this.db.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
        );
        const [owned] = await transaction
          .select()
          .from(userWallets)
          .where(eq(userWallets.address, address));
        if (owned)
          throw new ApiError(
            409,
            owned.userId === userId ? 'WALLET_ALREADY_LINKED' : 'WALLET_OWNED_BY_ANOTHER_USER',
            owned.userId === userId
              ? 'This wallet is already linked to your account.'
              : 'This wallet is already linked to another account.',
          );
        const existing = await transaction
          .select({ id: userWallets.id })
          .from(userWallets)
          .where(eq(userWallets.userId, userId));
        const [created] = await transaction
          .insert(userWallets)
          .values({
            userId,
            address,
            chain: 'SOLANA',
            network,
            isPrimary: existing.length === 0,
            verifiedAt: new Date(),
          })
          .returning();
        return created!;
      });
      return serializeWallet(wallet);
    } catch (error) {
      if (error instanceof ApiError || !isUniqueViolation(error)) throw error;
      const [owned] = await this.db
        .select({ userId: userWallets.userId })
        .from(userWallets)
        .where(eq(userWallets.address, address));
      throw new ApiError(
        409,
        owned?.userId === userId ? 'WALLET_ALREADY_LINKED' : 'WALLET_OWNED_BY_ANOTHER_USER',
        owned?.userId === userId
          ? 'This wallet is already linked to your account.'
          : 'This wallet is already linked to another account.',
      );
    }
  }

  async list(userId: string): Promise<UserWalletDto[]> {
    const wallets = await this.db
      .select()
      .from(userWallets)
      .where(eq(userWallets.userId, userId))
      .orderBy(asc(userWallets.createdAt), asc(userWallets.id));
    return wallets.map(serializeWallet);
  }

  async unlink(userId: string, walletId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const wallets = await transaction
        .select()
        .from(userWallets)
        .where(eq(userWallets.userId, userId))
        .orderBy(asc(userWallets.createdAt), asc(userWallets.id));
      const target = wallets.find((wallet) => wallet.id === walletId);
      if (!target) throw new ApiError(404, 'WALLET_NOT_FOUND', 'Wallet link does not exist.');
      if (wallets.length === 1)
        throw new ApiError(
          409,
          'WALLET_LAST_AUTH_METHOD',
          'Link another wallet before unlinking your only authentication method.',
        );
      await transaction
        .delete(userWallets)
        .where(and(eq(userWallets.id, walletId), eq(userWallets.userId, userId)));
      if (target.isPrimary) {
        const replacement = wallets.find((wallet) => wallet.id !== walletId)!;
        await transaction
          .update(userWallets)
          .set({ isPrimary: true, updatedAt: new Date() })
          .where(eq(userWallets.id, replacement.id));
      }
    });
  }

  async makePrimary(userId: string, walletId: string): Promise<UserWalletDto> {
    const wallet = await this.db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const [target] = await transaction
        .select()
        .from(userWallets)
        .where(and(eq(userWallets.id, walletId), eq(userWallets.userId, userId)));
      if (!target) throw new ApiError(404, 'WALLET_NOT_FOUND', 'Wallet link does not exist.');
      if (!target.isPrimary) {
        await transaction
          .update(userWallets)
          .set({ isPrimary: false, updatedAt: new Date() })
          .where(and(eq(userWallets.userId, userId), eq(userWallets.isPrimary, true)));
        const [updated] = await transaction
          .update(userWallets)
          .set({ isPrimary: true, updatedAt: new Date() })
          .where(eq(userWallets.id, walletId))
          .returning();
        return updated!;
      }
      return target;
    });
    return serializeWallet(wallet);
  }
}
