import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { sql } from 'drizzle-orm';
import { users, type Database } from '@trade-the-pool/database';
import {
  marketSymbolSchema,
  orderRequestSchema,
  paginationSchema,
  priceToString,
  uuidSchema,
  type Environment,
} from '@trade-the-pool/shared';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
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
import {
  AccountSnapshotService,
  EntryReadService,
  LeaderboardService,
  TournamentReadService,
  TradingApiService,
} from './services.js';
import type {
  ControllableMarketPriceProvider,
  MarketHistoryProvider,
  MarketPriceProvider,
} from '@trade-the-pool/market-data';

export type ApiRuntimeConfig = Pick<
  Environment,
  | 'NODE_ENV'
  | 'DEV_AUTH_ENABLED'
  | 'API_DOCS_ENABLED'
  | 'CORS_ALLOWED_ORIGINS'
  | 'SESSION_TTL_SECONDS'
>;

export type AppDependencies = {
  db: Database;
  market: MarketPriceProvider;
  store: KeyValueStore;
  config: ApiRuntimeConfig;
  hub?: RealtimeHub;
  close?: () => Promise<void>;
};

const defaultConfig: ApiRuntimeConfig = {
  NODE_ENV: 'test',
  DEV_AUTH_ENABLED: false,
  API_DOCS_ENABLED: false,
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
  SESSION_TTL_SECONDS: 86_400,
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
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? (config.NODE_ENV === 'test' ? 'silent' : 'info') },
    genReqId: (request) => request.headers['x-request-id']?.toString() ?? randomUUID(),
    bodyLimit: 32 * 1024,
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(cookie);
  await app.register(cors, {
    credentials: true,
    origin: config.CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()),
    methods: ['GET', 'POST', 'OPTIONS'],
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

  app.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    if (normalized.statusCode >= 500) request.log.error({ err: error }, 'request failed');
    else request.log.warn({ code: normalized.code }, 'request rejected');
    if (/^\/v1\/(auth|orders|tournaments\/[^/]+\/entries)/.test(request.url))
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
      await Promise.all(
        ['BTC-USD', 'ETH-USD', 'SOL-USD'].map((symbol) =>
          dependencies.market.getSnapshot(symbol as never),
        ),
      );
      return {
        status: 'ready',
        dependencies: { postgres: 'ok', redis: 'ok', marketData: 'ok' },
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
  const snapshots = new AccountSnapshotService(dependencies.db, dependencies.market);
  const tournaments = new TournamentReadService(dependencies.db);
  const leaderboards = new LeaderboardService(dependencies.db, snapshots, dependencies.store, hub);
  const trading = new TradingApiService(
    dependencies.db,
    dependencies.market,
    snapshots,
    leaderboards,
    hub,
  );
  const entries = new EntryReadService(dependencies.db, snapshots, leaderboards);

  app.addHook('onRequest', async (request) => {
    request.authenticatedUser = await authentication.resolveSession(
      request.cookies[SESSION_COOKIE],
    );
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

  if (config.DEV_AUTH_ENABLED) {
    if (config.NODE_ENV === 'production')
      throw new Error('Development authentication cannot be enabled in production');
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
        const session = await authentication.createSession(body.userId);
        setSessionCookie(
          reply,
          session.id,
          config.NODE_ENV === 'production',
          config.SESSION_TTL_SECONDS,
        );
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
    const user = requireUser(request);
    await authentication.invalidate(request.cookies[SESSION_COOKIE]);
    clearSessionCookie(reply, config.NODE_ENV === 'production');
    audit(request, 'auth.logout', { userId: user.id });
    return reply.status(204).send();
  });

  const tournamentQuerySchema = paginationSchema
    .extend({
      status: z
        .enum([
          'DRAFT',
          'OPEN',
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
          'OPEN',
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
        side: body.side,
      });
      const engineRequest =
        body.side === 'BUY'
          ? {
              entryId: body.entryId,
              symbol: body.symbol,
              side: body.side,
              requestedNotional: body.notional,
              idempotencyKey,
            }
          : body.amount.type === 'QUANTITY'
            ? {
                entryId: body.entryId,
                symbol: body.symbol,
                side: body.side,
                quantity: body.amount.quantity,
                idempotencyKey,
              }
            : {
                entryId: body.entryId,
                symbol: body.symbol,
                side: body.side,
                percentageBps: body.amount.percentageBps,
                idempotencyKey,
              };
      const result = await trading.execute(engineRequest);
      audit(request, result.replayed ? 'order.replayed' : 'order.filled', {
        entryId: body.entryId,
        orderId: result.order.id,
        fillId: result.fill.id,
      });
      return reply.status(201).send({
        data: {
          orderId: result.order.id,
          fillId: result.fill.id,
          status: result.order.status,
          idempotentReplay: result.replayed,
          symbol: result.order.symbol,
          side: result.order.side,
          requestedNotional: body.side === 'BUY' ? body.notional : null,
          quantity: result.fill.quantity,
          referencePrice: result.fill.referencePrice,
          fillPrice: result.fill.fillPrice,
          spread: result.fill.spreadAmount,
          slippage: result.fill.slippageAmount,
          fee: result.fill.feeAmount,
          resultingCash: result.account.cash,
          realizedPnL: result.account.realizedPnL,
          unrealizedPnL: result.account.unrealizedPnL,
          equity: result.account.equity,
        },
      });
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
      interval: z.enum(['1m', '5m', '15m', '1h']).default('1m'),
      limit: z.coerce.number().int().min(1).max(500).default(240),
    })
    .strict();
  app.get(
    '/v1/markets/:symbol',
    { schema: { tags: ['Markets'], params: openApiSchema(marketParameterSchema) } },
    async (request) => {
      const { symbol } = parse(marketParameterSchema, request.params);
      const snapshot = await dependencies.market.getSnapshot(symbol);
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
      const { interval, limit } = parse(candleQuerySchema, request.query);
      const market = dependencies.market as Partial<MarketHistoryProvider>;
      if (typeof market.getCandles !== 'function')
        throw new ApiError(404, 'NOT_FOUND', 'Market candle history is unavailable.');
      return {
        data: market.getCandles(symbol, interval, limit).map((candle) => ({
          timestamp: candle.timestamp,
          open: priceToString(candle.open),
          high: priceToString(candle.high),
          low: priceToString(candle.low),
          close: priceToString(candle.close),
        })),
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
    registerRealtime(realtimeApp, { hub, authorization, rateLimiter });
  });
  if (dependencies.close) app.addHook('onClose', dependencies.close);
  return app;
}
