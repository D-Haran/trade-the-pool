import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { sql } from 'drizzle-orm';
import { users, type Database } from '@trade-the-pool/database';
import {
  candleIntervalSchema,
  marketSymbolSchema,
  decimalToString,
  orderRequestSchema,
  paginationSchema,
  positionProtectionRequestSchema,
  priceToString,
  quantityToString,
  uuidSchema,
  type Environment,
} from '@trade-the-pool/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AuthenticationService,
  clearSessionCookie,
  requireUser,
  SESSION_COOKIE,
  setSessionCookie,
} from './auth.js';
import { AuthorizationService } from './authorization.js';
import { ApiError, normalizeError } from './errors.js';
import { RATE_LIMITS, RateLimiter, type KeyValueStore } from './infrastructure.js';
import { registerRealtime, RealtimeHub } from './realtime.js';
import { enforceCsrf, parseAllowedOrigins } from './security.js';
import {
  WalletAuthenticationService,
  createWalletFlowBinding,
  WALLET_FLOW_COOKIE,
  walletSubject,
  type WalletProof,
} from './wallet-auth.js';
import {
  AccountSnapshotService,
  EntryReadService,
  LeaderboardService,
  TournamentReadService,
  TradingApiService,
} from './services.js';
import {
  SUPPORTED_SYMBOLS,
  type ControllableMarketPriceProvider,
  type MarketHistoryProvider,
  type MarketDataProvider,
  type MarketPriceProvider,
} from '@trade-the-pool/market-data';

export type ApiRuntimeConfig = Pick<
  Environment,
  | 'NODE_ENV'
  | 'DEV_AUTH_ENABLED'
  | 'API_DOCS_ENABLED'
  | 'TRUST_PROXY'
  | 'CORS_ALLOWED_ORIGINS'
  | 'SESSION_TTL_SECONDS'
  | 'WALLET_AUTH_ENABLED'
  | 'SOLANA_CLUSTER'
  | 'WALLET_AUTH_ORIGIN'
  | 'WALLET_AUTH_DOMAIN'
  | 'WALLET_CHALLENGE_TTL_SECONDS'
>;

export type AppDependencies = {
  db: Database;
  market: MarketPriceProvider;
  store: KeyValueStore;
  config: ApiRuntimeConfig;
  hub?: RealtimeHub;
  trading?: TradingApiService;
  close?: () => Promise<void>;
};

const defaultConfig: ApiRuntimeConfig = {
  NODE_ENV: 'test',
  DEV_AUTH_ENABLED: false,
  API_DOCS_ENABLED: false,
  TRUST_PROXY: false,
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
  SESSION_TTL_SECONDS: 604_800,
  WALLET_AUTH_ENABLED: true,
  SOLANA_CLUSTER: 'devnet',
  WALLET_AUTH_ORIGIN: 'http://localhost:3000',
  WALLET_AUTH_DOMAIN: 'localhost:3000',
  WALLET_CHALLENGE_TTL_SECONDS: 300,
};

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(400, 'INVALID_REQUEST', 'Request validation failed.', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  return result.data;
}

function openApiSchema(schema: z.ZodTypeAny): object {
  return zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
}

export async function buildApp(dependencies?: AppDependencies): Promise<FastifyInstance> {
  const config = dependencies?.config ?? defaultConfig;
  if (config.NODE_ENV === 'production' && config.DEV_AUTH_ENABLED)
    throw new Error('Development authentication cannot be enabled in production');
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? (config.NODE_ENV === 'test' ? 'silent' : 'info') },
    genReqId: (request) => request.headers['x-request-id']?.toString() ?? randomUUID(),
    bodyLimit: 32 * 1024,
    trustProxy: config.TRUST_PROXY,
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(cookie);
  const allowedOrigins = parseAllowedOrigins(config.CORS_ALLOWED_ORIGINS);
  await app.register(cors, {
    credentials: true,
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(websocket, { options: { maxPayload: 8 * 1024 } });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Trade the Pool API', version: '1.0.0' },
      servers: [{ url: '/v1' }],
    },
  });
  if (config.API_DOCS_ENABLED)
    await app.register(swaggerUi, {
      routePrefix: '/documentation',
      uiConfig: { docExpansion: 'list' },
    });
  if (config.API_DOCS_ENABLED) app.get('/openapi.json', async () => app.swagger());

  app.decorateRequest('authenticatedUser', null);
  app.decorateRequest('authenticatedSession', null);

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    if (normalized.statusCode >= 500) request.log.error({ err: error }, 'request failed');
    else request.log.warn({ code: normalized.code }, 'request rejected');
    if (/^\/v1\/(auth|me\/wallets|orders|tournaments\/[^/]+\/entries)/.test(request.url))
      request.log.warn(
        {
          audit: true,
          eventType: 'sensitive_operation.failed',
          requestId: request.id,
          userId: request.authenticatedUser?.id,
          code: normalized.code,
          timestamp: new Date().toISOString(),
        },
        'audit event',
      );
    return reply.status(normalized.statusCode).send({
      error: {
        code: normalized.code,
        message: normalized.message,
        requestId: request.id,
        ...(normalized.details ? { details: normalized.details } : {}),
      },
    });
  });

  app.get('/health', async (request) => ({ status: 'ok', requestId: request.id }));
  app.get('/health/live', async (request) => ({ status: 'ok', requestId: request.id }));
  app.get('/health/ready', async (request, reply) => {
    if (!dependencies)
      return reply.status(503).send({ status: 'not_ready', requestId: request.id });
    try {
      await dependencies.db.execute(sql`select 1`);
      await dependencies.store.ping();
      const richerMarket = dependencies.market as Partial<MarketDataProvider>;
      const marketHealth = richerMarket.getHealth?.();
      if (!marketHealth)
        await Promise.all(
          SUPPORTED_SYMBOLS.map((symbol) => dependencies.market.getSnapshot(symbol)),
        );
      const marketStatus = marketHealth?.markets.some((market) => market.status !== 'LIVE')
        ? 'degraded'
        : 'ok';
      return {
        status: marketStatus === 'ok' ? 'ready' : 'ready_degraded',
        dependencies: { postgres: 'ok', redis: 'ok', marketData: marketStatus },
        ...(marketHealth ? { marketData: marketHealth } : {}),
        requestId: request.id,
      };
    } catch (error) {
      request.log.error({ err: error }, 'readiness check failed');
      return reply.status(503).send({ status: 'not_ready', requestId: request.id });
    }
  });

  if (!dependencies) return app;

  const hub = dependencies.hub ?? new RealtimeHub();
  const authentication = new AuthenticationService(
    dependencies.db,
    dependencies.store,
    config.SESSION_TTL_SECONDS,
  );
  const authorization = new AuthorizationService(dependencies.db);
  const rateLimiter = new RateLimiter(dependencies.store);
  const walletAuthentication = new WalletAuthenticationService(
    dependencies.db,
    dependencies.store,
    {
      enabled: config.WALLET_AUTH_ENABLED,
      cluster: config.SOLANA_CLUSTER,
      origin: config.WALLET_AUTH_ORIGIN,
      domain: config.WALLET_AUTH_DOMAIN,
      challengeTtlSeconds: config.WALLET_CHALLENGE_TTL_SECONDS,
    },
  );
  const snapshots = new AccountSnapshotService(dependencies.db, dependencies.market);
  const tournaments = new TournamentReadService(dependencies.db);
  const leaderboards = new LeaderboardService(dependencies.db, snapshots, dependencies.store, hub);
  const trading =
    dependencies.trading ??
    new TradingApiService(dependencies.db, dependencies.market, snapshots, leaderboards, hub);
  const entries = new EntryReadService(dependencies.db, snapshots, leaderboards);

  app.get('/health/market-data', async (request) => ({
    status: 'ok',
    marketData: (dependencies.market as Partial<MarketDataProvider>).getHealth?.() ?? null,
    realtime: hub.getMetrics(),
    requestId: request.id,
  }));

  app.addHook('onRequest', async (request) => enforceCsrf(request, allowedOrigins));
  app.addHook('onRequest', async (request) => {
    const session = await authentication.resolveSession(request.cookies[SESSION_COOKIE]);
    request.authenticatedSession = session;
    request.authenticatedUser = session?.user ?? null;
  });

  const audit = (
    request: FastifyRequest,
    eventType: string,
    fields: Record<string, unknown> = {},
  ) =>
    request.log.info(
      {
        audit: true,
        eventType,
        requestId: request.id,
        userId: request.authenticatedUser?.id,
        timestamp: new Date().toISOString(),
        ...fields,
      },
      'audit event',
    );

  const walletRateLimit = async (
    scope: string,
    subject: string,
    policy: (typeof RATE_LIMITS)[keyof typeof RATE_LIMITS],
  ) => {
    try {
      await rateLimiter.consume(scope, subject, policy);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        'WALLET_AUTHENTICATION_UNAVAILABLE',
        'Wallet authentication is temporarily unavailable.',
      );
    }
  };

  const assertConfiguredWalletOrigin = (request: FastifyRequest) => {
    const origin = request.headers.origin;
    if (origin && origin !== config.WALLET_AUTH_ORIGIN)
      throw new ApiError(403, 'CSRF_VALIDATION_FAILED', 'The wallet-auth origin is not allowed.');
  };

  const setWalletFlowCookie = (reply: FastifyReply, value: string) =>
    reply.setCookie(WALLET_FLOW_COOKIE, value, {
      path: '/v1',
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: config.WALLET_CHALLENGE_TTL_SECONDS,
      priority: 'high',
    });

  const clearWalletFlowCookie = (reply: FastifyReply) =>
    reply.clearCookie(WALLET_FLOW_COOKIE, {
      path: '/v1',
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      priority: 'high',
    });

  const walletAddressSchema = z.object({ address: z.string().min(32).max(44) }).strict();
  const walletProofSchema = z
    .object({
      challengeId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      address: z.string().min(32).max(44),
      signature: z.string().min(1).max(256),
      signedMessage: z.string().min(1).max(8192),
    })
    .strict();
  const walletIdSchema = z.object({ id: uuidSchema }).strict();

  const applyInvalidSignatureLimit = async (request: FastifyRequest, proof: WalletProof) => {
    try {
      return await walletAuthentication.verifyChallenge('LOGIN', proof, {
        browserBinding: request.cookies[WALLET_FLOW_COOKIE] ?? '',
        sessionId: request.authenticatedSession?.id,
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'WALLET_SIGNATURE_INVALID')
        await walletRateLimit(
          'wallet-invalid-signature',
          `${request.ip}:${walletSubject(proof.address)}`,
          RATE_LIMITS.walletInvalidSignature,
        );
      throw error;
    }
  };

  app.post(
    '/v1/auth/wallet/challenge',
    {
      schema: {
        tags: ['Authentication'],
        body: openApiSchema(walletAddressSchema),
      },
    },
    async (request, reply) => {
      assertConfiguredWalletOrigin(request);
      const body = parse(walletAddressSchema, request.body);
      await walletRateLimit('wallet-challenge-ip', request.ip, RATE_LIMITS.walletChallenge);
      await walletRateLimit(
        'wallet-challenge-address',
        walletSubject(body.address),
        RATE_LIMITS.walletChallenge,
      );
      const browserBinding = createWalletFlowBinding();
      const challenge = await walletAuthentication.issueChallenge('LOGIN', body.address, {
        browserBinding,
        sessionId: request.authenticatedSession?.id,
      });
      setWalletFlowCookie(reply, browserBinding);
      audit(request, 'wallet.challenge_issued', {
        purpose: 'LOGIN',
        walletSubject: walletSubject(body.address),
      });
      return { data: challenge };
    },
  );

  app.post(
    '/v1/auth/wallet/verify',
    {
      schema: {
        tags: ['Authentication'],
        body: openApiSchema(walletProofSchema),
      },
    },
    async (request, reply) => {
      assertConfiguredWalletOrigin(request);
      const proof = parse(walletProofSchema, request.body);
      clearWalletFlowCookie(reply);
      await walletRateLimit('wallet-verification', request.ip, RATE_LIMITS.walletVerification);
      const verified = await applyInvalidSignatureLimit(request, proof);
      const userId = await walletAuthentication.resolveOrCreateUser(
        verified.address,
        verified.network,
      );
      const previousSessionId = request.cookies[SESSION_COOKIE];
      const session = await authentication.rotateSession(userId, previousSessionId);
      if (previousSessionId) hub.disconnectSession(previousSessionId, 'Session rotated');
      setSessionCookie(
        reply,
        session.id,
        config.NODE_ENV === 'production',
        config.SESSION_TTL_SECONDS,
      );
      request.authenticatedSession = session;
      request.authenticatedUser = session.user;
      audit(request, 'wallet.login', {
        walletSubject: walletSubject(verified.address),
        network: verified.network,
      });
      return { data: { user: session.user, expiresInSeconds: config.SESSION_TTL_SECONDS } };
    },
  );

  app.post(
    '/v1/me/wallets/challenge',
    {
      schema: { tags: ['Wallets'], body: openApiSchema(walletAddressSchema) },
    },
    async (request, reply) => {
      assertConfiguredWalletOrigin(request);
      const user = requireUser(request);
      const session = request.authenticatedSession!;
      const body = parse(walletAddressSchema, request.body);
      await walletRateLimit('wallet-link', user.id, RATE_LIMITS.walletLink);
      const browserBinding = createWalletFlowBinding();
      const challenge = await walletAuthentication.issueChallenge('LINK', body.address, {
        browserBinding,
        userId: user.id,
        sessionId: session.id,
      });
      setWalletFlowCookie(reply, browserBinding);
      audit(request, 'wallet.challenge_issued', {
        purpose: 'LINK',
        walletSubject: walletSubject(body.address),
      });
      return { data: challenge };
    },
  );

  app.post(
    '/v1/me/wallets/verify',
    { schema: { tags: ['Wallets'], body: openApiSchema(walletProofSchema) } },
    async (request, reply) => {
      assertConfiguredWalletOrigin(request);
      const user = requireUser(request);
      const session = request.authenticatedSession!;
      const proof = parse(walletProofSchema, request.body);
      clearWalletFlowCookie(reply);
      await walletRateLimit('wallet-link-verify', user.id, RATE_LIMITS.walletLink);
      let verified;
      try {
        verified = await walletAuthentication.verifyChallenge('LINK', proof, {
          browserBinding: request.cookies[WALLET_FLOW_COOKIE] ?? '',
          userId: user.id,
          sessionId: session.id,
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'WALLET_SIGNATURE_INVALID')
          await walletRateLimit(
            'wallet-invalid-signature',
            `${request.ip}:${walletSubject(proof.address)}`,
            RATE_LIMITS.walletInvalidSignature,
          );
        throw error;
      }
      const wallet = await walletAuthentication.link(user.id, verified.address, verified.network);
      audit(request, 'wallet.linked', {
        walletId: wallet.id,
        walletSubject: walletSubject(wallet.address),
        isPrimary: wallet.isPrimary,
      });
      return reply.status(201).send({ data: wallet });
    },
  );

  app.get('/v1/me/wallets', { schema: { tags: ['Wallets'] } }, async (request) => ({
    data: await walletAuthentication.list(requireUser(request).id),
  }));

  app.delete(
    '/v1/me/wallets/:id',
    { schema: { tags: ['Wallets'], params: openApiSchema(walletIdSchema) } },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = parse(walletIdSchema, request.params);
      await walletRateLimit('wallet-unlink', user.id, RATE_LIMITS.walletLink);
      await walletAuthentication.unlink(user.id, id);
      audit(request, 'wallet.unlinked', { walletId: id });
      return reply.status(204).send();
    },
  );

  app.put(
    '/v1/me/wallets/:id/primary',
    {
      schema: {
        tags: ['Wallets'],
        params: openApiSchema(walletIdSchema),
        body: openApiSchema(z.object({}).strict()),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = parse(walletIdSchema, request.params);
      parse(z.object({}).strict(), request.body ?? {});
      await walletRateLimit('wallet-primary', user.id, RATE_LIMITS.walletLink);
      const wallet = await walletAuthentication.makePrimary(user.id, id);
      audit(request, 'wallet.primary_changed', { walletId: id });
      return { data: wallet };
    },
  );

  if (config.DEV_AUTH_ENABLED) {
    app.get('/v1/auth/dev/users', { schema: { tags: ['Authentication'] } }, async () => ({
      data: await dependencies.db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .orderBy(users.displayName),
    }));
    const developmentLoginSchema = z.object({ userId: uuidSchema }).strict();
    app.post(
      '/v1/auth/dev/login',
      { schema: { tags: ['Authentication'], body: openApiSchema(developmentLoginSchema) } },
      async (request, reply) => {
        await rateLimiter.consume('auth', request.ip, RATE_LIMITS.auth);
        const body = parse(developmentLoginSchema, request.body);
        const previousSessionId = request.cookies[SESSION_COOKIE];
        const session = await authentication.rotateSession(body.userId, previousSessionId);
        if (previousSessionId) hub.disconnectSession(previousSessionId, 'Session rotated');
        setSessionCookie(
          reply,
          session.id,
          config.NODE_ENV === 'production',
          config.SESSION_TTL_SECONDS,
        );
        request.authenticatedSession = session;
        request.authenticatedUser = session.user;
        audit(request, 'auth.login');
        return { data: { user: session.user, expiresInSeconds: config.SESSION_TTL_SECONDS } };
      },
    );
  }

  app.get('/v1/auth/me', { schema: { tags: ['Authentication'] } }, async (request) => ({
    data: { user: requireUser(request) },
  }));
  app.post('/v1/auth/logout', { schema: { tags: ['Authentication'] } }, async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    const user = request.authenticatedUser;
    await authentication.invalidate(sessionId);
    clearSessionCookie(reply, config.NODE_ENV === 'production');
    if (sessionId) hub.disconnectSession(sessionId, 'Session logged out');
    audit(request, 'auth.logout', { userId: user?.id, outcome: 'invalidated' });
    return reply.status(204).send();
  });

  const tournamentQuerySchema = paginationSchema
    .extend({
      status: z
        .enum([
          'DRAFT',
          'REGISTRATION_OPEN',
          'TRADING_ACTIVE',
          'ENTRY_CLOSED',
          'TRADING_CLOSED',
          'FINALIZING',
          'COMPLETED',
          'CANCELLED',
        ])
        .optional(),
      search: z.string().trim().min(1).max(120).optional(),
    })
    .strict();
  app.get(
    '/v1/tournaments',
    { schema: { tags: ['Tournaments'], querystring: openApiSchema(tournamentQuerySchema) } },
    async (request) => {
      const query = parse(tournamentQuerySchema, request.query);
      return tournaments.list(query, query, request.authenticatedUser?.id);
    },
  );
  const tournamentIdentifierSchema = z.object({ identifier: z.string().min(1).max(120) }).strict();
  app.get(
    '/v1/tournaments/:identifier',
    { schema: { tags: ['Tournaments'], params: openApiSchema(tournamentIdentifierSchema) } },
    async (request) => {
      const { identifier } = parse(tournamentIdentifierSchema, request.params);
      return { data: await tournaments.detail(identifier, request.authenticatedUser?.id) };
    },
  );
  const idParameterSchema = z.object({ id: uuidSchema }).strict();
  const emptyBodySchema = z.object({}).strict();
  app.post(
    '/v1/tournaments/:id/entries',
    {
      schema: {
        tags: ['Entries'],
        params: openApiSchema(idParameterSchema),
        body: openApiSchema(emptyBodySchema),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = parse(idParameterSchema, request.params);
      parse(emptyBodySchema, request.body ?? {});
      await authorization.canCreateEntry(user.id);
      await rateLimiter.consume('entry-create', user.id, RATE_LIMITS.entryCreation);
      const result = await trading.createEntry(id, user.id);
      audit(request, 'entry.created', { tournamentId: id, entryId: result.id });
      return reply.status(201).send({ data: result });
    },
  );

  const entryQuerySchema = paginationSchema
    .extend({
      tournamentId: uuidSchema.optional(),
      status: z
        .enum([
          'DRAFT',
          'REGISTRATION_OPEN',
          'TRADING_ACTIVE',
          'ENTRY_CLOSED',
          'TRADING_CLOSED',
          'FINALIZING',
          'COMPLETED',
          'CANCELLED',
        ])
        .optional(),
    })
    .strict();
  app.get(
    '/v1/me/entries',
    { schema: { tags: ['Entries'], querystring: openApiSchema(entryQuerySchema) } },
    async (request) => {
      const user = requireUser(request);
      const query = parse(entryQuerySchema, request.query);
      return entries.mine(user.id, query, query);
    },
  );
  app.get(
    '/v1/entries/:id',
    { schema: { tags: ['Entries'], params: openApiSchema(idParameterSchema) } },
    async (request) => {
      const user = requireUser(request);
      const { id } = parse(idParameterSchema, request.params);
      await authorization.canReadEntry(user.id, id);
      return { data: await entries.detail(id) };
    },
  );
  app.get(
    '/v1/entries/:id/positions',
    { schema: { tags: ['Entries'], params: openApiSchema(idParameterSchema) } },
    async (request) => {
      const user = requireUser(request);
      const { id } = parse(idParameterSchema, request.params);
      await authorization.canReadEntry(user.id, id);
      return { data: await entries.positions(id) };
    },
  );
  app.get(
    '/v1/entries/:id/orders',
    {
      schema: {
        tags: ['Orders'],
        params: openApiSchema(idParameterSchema),
        querystring: openApiSchema(paginationSchema),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = parse(idParameterSchema, request.params);
      const query = parse(paginationSchema, request.query);
      await authorization.canReadPrivateHistory(user.id, id);
      return entries.history(id, query);
    },
  );
  app.get(
    '/v1/entries/:id/fills',
    {
      schema: {
        tags: ['Orders'],
        params: openApiSchema(idParameterSchema),
        querystring: openApiSchema(paginationSchema),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = parse(idParameterSchema, request.params);
      const query = parse(paginationSchema, request.query);
      await authorization.canReadPrivateHistory(user.id, id);
      return entries.fills(id, query);
    },
  );
  app.get(
    '/v1/entries/:id/performance',
    { schema: { tags: ['Entries'], params: openApiSchema(idParameterSchema) } },
    async (request) => {
      const user = requireUser(request);
      const { id } = parse(idParameterSchema, request.params);
      await authorization.canReadPrivateHistory(user.id, id);
      return { data: await entries.performance(id) };
    },
  );

  const idempotencyHeaderSchema = z
    .object({ 'idempotency-key': z.string().min(1).max(128) })
    .passthrough();
  app.post(
    '/v1/orders',
    {
      schema: {
        tags: ['Orders'],
        body: openApiSchema(orderRequestSchema),
        headers: openApiSchema(idempotencyHeaderSchema),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = parse(orderRequestSchema, request.body);
      await authorization.canTradeEntry(user.id, body.entryId);
      await rateLimiter.consume('order-submit', user.id, RATE_LIMITS.orderSubmission);
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7E]{1,128}$/.test(idempotencyKey))
        throw new ApiError(
          400,
          'INVALID_IDEMPOTENCY_KEY',
          'A valid Idempotency-Key header is required.',
        );
      audit(request, 'order.submitted', {
        entryId: body.entryId,
        symbol: body.symbol,
      });
      const engineRequest =
        'intent' in body
          ? {
              entryId: body.entryId,
              symbol: body.symbol,
              positionSide: body.positionSide,
              intent: body.intent,
              orderType: body.execution.type,
              ...(body.intent === 'OPEN'
                ? {
                    ...(body.sizing.type === 'MARGIN'
                      ? { requestedMargin: body.sizing.amount }
                      : { requestedNotional: body.sizing.amount }),
                    leverage: body.leverage,
                    takeProfitPrice: body.takeProfitPrice,
                    stopLossPrice: body.stopLossPrice,
                  }
                : body.amount.type === 'QUANTITY'
                  ? { quantity: body.amount.quantity }
                  : { percentageBps: body.amount.percentageBps }),
              ...(body.execution.type === 'LIMIT'
                ? { limitPrice: body.execution.limitPrice }
                : body.execution.type === 'STOP_MARKET'
                  ? { triggerPrice: body.execution.stopPrice }
                  : {}),
              idempotencyKey,
            }
          : body.side === 'BUY'
            ? {
                entryId: body.entryId,
                symbol: body.symbol,
                positionSide: 'LONG' as const,
                intent: 'OPEN' as const,
                orderType: 'MARKET' as const,
                requestedNotional: body.notional,
                leverage: 1,
                idempotencyKey,
              }
            : body.amount.type === 'QUANTITY'
              ? {
                  entryId: body.entryId,
                  symbol: body.symbol,
                  positionSide: 'LONG' as const,
                  intent: 'CLOSE' as const,
                  orderType: 'MARKET' as const,
                  quantity: body.amount.quantity,
                  idempotencyKey,
                }
              : {
                  entryId: body.entryId,
                  symbol: body.symbol,
                  positionSide: 'LONG' as const,
                  intent: 'CLOSE' as const,
                  orderType: 'MARKET' as const,
                  percentageBps: body.amount.percentageBps,
                  idempotencyKey,
                };
      const result = await trading.execute(engineRequest);
      audit(
        request,
        result.replayed ? 'order.replayed' : `order.${result.order.status.toLowerCase()}`,
        {
          entryId: body.entryId,
          orderId: result.order.id,
          fillId: result.fill?.id,
        },
      );
      return reply.status(201).send({
        data: {
          orderId: result.order.id,
          fillId: result.fill?.id ?? null,
          status: result.order.status,
          idempotentReplay: result.replayed,
          symbol: result.order.symbol,
          side: result.order.side,
          positionSide: result.order.positionSide,
          intent: result.order.intent,
          orderType: result.order.orderType,
          leverage: result.order.leverage,
          requestedNotional:
            'intent' in body
              ? body.intent === 'OPEN'
                ? result.order.requestedNotional
                : null
              : body.side === 'BUY'
                ? body.notional
                : null,
          quantity: result.fill?.quantity ?? null,
          referencePrice: result.fill?.referencePrice ?? null,
          fillPrice: result.fill?.fillPrice ?? null,
          spread: result.fill?.spreadAmount ?? null,
          slippage: result.fill?.slippageAmount ?? null,
          fee: result.fill?.feeAmount ?? null,
          resultingCash: result.account.cash,
          realizedPnL: result.account.realizedPnL,
          unrealizedPnL: result.account.unrealizedPnL,
          equity: result.account.equity,
        },
      });
    },
  );

  const orderParameterSchema = z.object({ id: uuidSchema, orderId: uuidSchema }).strict();
  app.delete(
    '/v1/entries/:id/orders/:orderId',
    { schema: { tags: ['Orders'], params: openApiSchema(orderParameterSchema) } },
    async (request) => {
      const user = requireUser(request);
      const { id, orderId } = parse(orderParameterSchema, request.params);
      await authorization.canTradeEntry(user.id, id);
      const cancelled = await trading.cancel(id, orderId);
      audit(request, 'order.cancelled', { entryId: id, orderId });
      return { data: { id: cancelled.id, status: cancelled.status } };
    },
  );

  const positionParameterSchema = z.object({ id: uuidSchema, symbol: marketSymbolSchema }).strict();
  app.put(
    '/v1/entries/:id/positions/:symbol/protection',
    {
      schema: {
        tags: ['Orders'],
        params: openApiSchema(positionParameterSchema),
        body: openApiSchema(positionProtectionRequestSchema),
        headers: openApiSchema(idempotencyHeaderSchema),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id, symbol } = parse(positionParameterSchema, request.params);
      const body = parse(positionProtectionRequestSchema, request.body);
      await authorization.canTradeEntry(user.id, id);
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7E]{1,128}$/.test(idempotencyKey))
        throw new ApiError(
          400,
          'INVALID_IDEMPOTENCY_KEY',
          'A valid Idempotency-Key header is required.',
        );
      const protection = await trading.protect({
        entryId: id,
        symbol,
        ...body,
        idempotencyKey,
      });
      audit(request, 'position.protection_updated', { entryId: id, symbol });
      return {
        data: protection.map((order) => ({
          id: order.id,
          type: order.orderType,
          triggerPrice: order.triggerPrice,
          status: order.status,
        })),
      };
    },
  );

  app.get(
    '/v1/tournaments/:id/leaderboard',
    {
      schema: {
        tags: ['Leaderboard'],
        params: openApiSchema(idParameterSchema),
        querystring: openApiSchema(paginationSchema),
      },
    },
    async (request) => {
      const { id } = parse(idParameterSchema, request.params);
      const query = parse(paginationSchema, request.query);
      return leaderboards.page(id, query, request.authenticatedUser?.id);
    },
  );

  const marketParameterSchema = z.object({ symbol: marketSymbolSchema }).strict();
  const candleQuerySchema = z
    .object({
      interval: candleIntervalSchema.default('1m'),
      limit: z.coerce.number().int().min(1).max(1_000).default(600),
      before: z
        .string()
        .datetime({ offset: true })
        .transform((value) => new Date(value))
        .optional(),
    })
    .strict();
  const serializeMarket = async (symbol: z.infer<typeof marketSymbolSchema>) => {
    const market = dependencies.market as Partial<MarketDataProvider>;
    const view = market.getMarketView?.(symbol);
    const fallback = view ? null : await dependencies.market.getSnapshot(symbol);
    const visible = view?.exchangePrice ?? view?.authoritativeMark ?? fallback;
    if (!visible)
      throw new ApiError(503, 'MARKET_DATA_UNAVAILABLE', `${symbol} market data is unavailable.`);
    const statistics = view?.statistics ?? market.getStatistics?.(symbol) ?? null;
    const health = market.getHealth?.();
    const metadata = market.getMarkets?.().find((item) => item.symbol === symbol);
    const mark = view?.authoritativeMark ?? fallback;
    const age = Date.now() - visible.marketTimestamp.getTime();
    return {
      symbol: visible.symbol,
      dataMode: health?.mode ?? 'live',
      price: priceToString(visible.price),
      markPrice: mark ? priceToString(mark.price) : null,
      marketTimestamp: visible.marketTimestamp,
      markTimestamp: mark?.marketTimestamp ?? null,
      source: visible.source,
      markSource: mark?.source ?? null,
      status:
        view?.status ?? (age > 30_000 || age < 0 ? 'STALE' : age > 5_000 ? 'DELAYED' : 'LIVE'),
      exchangeStatus:
        view?.exchangeStatus ??
        (age > 30_000 || age < 0 ? 'STALE' : age > 5_000 ? 'DELAYED' : 'LIVE'),
      availability: view?.availability ?? 'ACTIVE',
      deviationBasisPoints: view?.deviationBasisPoints?.toString() ?? null,
      change24hBasisPoints: statistics?.change24hBasisPoints?.toString() ?? null,
      change15mBasisPoints: statistics?.change15mBasisPoints?.toString() ?? null,
      range5mBasisPoints: statistics?.range5mBasisPoints?.toString() ?? null,
      high24h: statistics?.high24h ? priceToString(statistics.high24h) : null,
      low24h: statistics?.low24h ? priceToString(statistics.low24h) : null,
      volume24h: statistics?.volume24h ? quantityToString(statistics.volume24h) : null,
      provenance: health?.components ?? {
        currentPrice: visible.source,
        statistics24h: visible.source,
        historicalCandles: visible.source,
        realtimeCandles: visible.source,
        subMinuteCandles: visible.source,
        orderBook: visible.source,
        recentTrades: visible.source,
        authoritativeMark: mark?.source ?? visible.source,
        comparisonPrice: visible.source,
      },
      metadata: metadata
        ? {
            assetClass: metadata.assetClass,
            displayName: metadata.displayName,
            baseCurrency: metadata.baseCurrency,
            quoteCurrency: metadata.quoteCurrency,
            tradingSchedule: metadata.tradingSchedule,
            pricePrecision: metadata.pricePrecision,
            quantityPrecision: metadata.quantityPrecision,
            iconKey: metadata.iconKey,
            accent: metadata.accent,
            maxLeverage: metadata.maxLeverage,
            sortOrder: metadata.sortOrder,
          }
        : {
            assetClass: 'CRYPTO',
            displayName: symbol.split('-')[0],
            baseCurrency: symbol.split('-')[0],
            quoteCurrency: 'USD',
            tradingSchedule: '24/7',
            pricePrecision: 8,
            quantityPrecision: 8,
            iconKey: symbol.split('-')[0].toLowerCase(),
            accent: '#8b96a3',
            maxLeverage: 1,
            sortOrder: 999,
          },
    };
  };
  app.get('/v1/markets', { schema: { tags: ['Markets'] } }, async () => ({
    data: await Promise.all(
      SUPPORTED_SYMBOLS.map((symbol) =>
        serializeMarket(symbol as z.infer<typeof marketSymbolSchema>),
      ),
    ),
  }));
  app.get(
    '/v1/markets/:symbol',
    { schema: { tags: ['Markets'], params: openApiSchema(marketParameterSchema) } },
    async (request) => {
      const { symbol } = parse(marketParameterSchema, request.params);
      return { data: await serializeMarket(symbol) };
    },
  );
  app.get(
    '/v1/markets/:symbol/candles',
    {
      schema: {
        tags: ['Markets'],
        params: openApiSchema(marketParameterSchema),
        querystring: openApiSchema(candleQuerySchema),
      },
    },
    async (request) => {
      const { symbol } = parse(marketParameterSchema, request.params);
      const { interval, limit, before } = parse(candleQuerySchema, request.query);
      const market = dependencies.market as Partial<MarketHistoryProvider>;
      if (typeof market.getCandles !== 'function')
        throw new ApiError(404, 'NOT_FOUND', 'Market candle history is unavailable.');
      const candles = await market.getCandles(symbol, interval, {
        limit,
        ...(before ? { before } : {}),
      });
      return {
        data: candles.map((candle) => ({
          timestamp: candle.timestamp,
          open: priceToString(candle.open),
          high: priceToString(candle.high),
          low: priceToString(candle.low),
          close: priceToString(candle.close),
          volume: candle.volume === null ? null : quantityToString(candle.volume),
        })),
        pagination: {
          hasMore: candles.length === limit,
          nextBefore: candles[0]?.timestamp.toISOString() ?? null,
        },
        provenance: (() => {
          const components = (market as Partial<MarketDataProvider>).getHealth?.().components;
          return interval.endsWith('s')
            ? (components?.subMinuteCandles ?? null)
            : (components?.historicalCandles ?? null);
        })(),
      };
    },
  );
  const depthQuerySchema = z
    .object({ depth: z.coerce.number().int().min(1).max(50).default(25) })
    .strict();
  app.get(
    '/v1/markets/:symbol/book',
    {
      schema: {
        tags: ['Markets'],
        params: openApiSchema(marketParameterSchema),
        querystring: openApiSchema(depthQuerySchema),
      },
    },
    async (request) => {
      const { symbol } = parse(marketParameterSchema, request.params);
      const { depth } = parse(depthQuerySchema, request.query);
      const market = dependencies.market as Partial<MarketDataProvider>;
      if (!market.getOrderBook)
        throw new ApiError(404, 'NOT_FOUND', 'Market depth is unavailable.');
      const book = market.getOrderBook(symbol, depth);
      return {
        data: {
          symbol: book.symbol,
          venue: book.venue,
          status: book.status,
          timestamp: book.timestamp,
          bids: book.bids.map((level) => ({
            price: priceToString(level.price),
            quantity: quantityToString(level.quantity),
            total: quantityToString(level.total),
          })),
          asks: book.asks.map((level) => ({
            price: priceToString(level.price),
            quantity: quantityToString(level.quantity),
            total: quantityToString(level.total),
          })),
          spread: book.spread ? decimalToString(book.spread) : null,
          spreadBasisPoints: book.spreadBasisPoints?.toString() ?? null,
        },
        provenance: market.getHealth?.().components.orderBook ?? book.venue,
      };
    },
  );
  const tradesQuerySchema = z
    .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
    .strict();
  app.get(
    '/v1/markets/:symbol/trades',
    {
      schema: {
        tags: ['Markets'],
        params: openApiSchema(marketParameterSchema),
        querystring: openApiSchema(tradesQuerySchema),
      },
    },
    async (request) => {
      const { symbol } = parse(marketParameterSchema, request.params);
      const { limit } = parse(tradesQuerySchema, request.query);
      const market = dependencies.market as Partial<MarketDataProvider>;
      if (!market.getRecentTrades)
        throw new ApiError(404, 'NOT_FOUND', 'Recent market trades are unavailable.');
      return {
        data: market.getRecentTrades(symbol, limit).map((trade) => ({
          id: trade.id,
          symbol: trade.symbol,
          price: priceToString(trade.price),
          quantity: quantityToString(trade.quantity),
          side: trade.side,
          timestamp: trade.timestamp,
          venue: trade.venue,
        })),
        provenance: market.getHealth?.().components.recentTrades ?? null,
      };
    },
  );

  if (config.NODE_ENV === 'development' && config.DEV_AUTH_ENABLED) {
    const developmentMarketSchema = z
      .object({
        symbol: marketSymbolSchema,
        price: z.string().regex(/^(?!0+(?:\.0+)?$)\d+(?:\.\d{1,8})?$/),
      })
      .strict();
    app.post(
      '/v1/dev/market/advance',
      {
        schema: {
          tags: ['Development'],
          body: openApiSchema(developmentMarketSchema),
        },
      },
      async (request) => {
        requireUser(request);
        const body = parse(developmentMarketSchema, request.body);
        const market = dependencies.market as Partial<ControllableMarketPriceProvider>;
        if (typeof market.advancePrice !== 'function')
          throw new ApiError(404, 'NOT_FOUND', 'Development market controls are unavailable.');
        const snapshot = market.advancePrice(body.symbol, body.price, new Date());
        // The observable market listener projects risk asynchronously. Development controls are
        // used by deterministic browser tests, so do not acknowledge a price step until the
        // authoritative order/liquidation pass for that step has completed.
        await trading.processMarketTick(body.symbol);
        return {
          data: {
            symbol: snapshot.symbol,
            price: priceToString(snapshot.price),
            marketTimestamp: snapshot.marketTimestamp,
            source: snapshot.source,
          },
        };
      },
    );
  }

  await app.register(async (realtimeApp) => {
    registerRealtime(realtimeApp, {
      hub,
      authorization,
      authentication,
      rateLimiter,
      allowedOrigins,
    });
  });
  if (dependencies.close) app.addHook('onClose', dependencies.close);
  return app;
}
