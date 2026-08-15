import {
  decimalToString,
  priceToString,
  quantityToString,
  realtimeSubscriptionSchema,
  type RealtimeEvent,
} from '@trade-the-pool/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  SUPPORTED_SYMBOLS,
  type MarketDataProvider,
  type MarketPriceProvider,
  type ObservableMarketPriceProvider,
} from '@trade-the-pool/market-data';
import { requireUser, type AuthenticationService } from './auth.js';
import type { AuthorizationService } from './authorization.js';
import { normalizeError } from './errors.js';
import { RATE_LIMITS, type RateLimiter } from './infrastructure.js';
import type { EventPublisher, LeaderboardService } from './services.js';
import { assertAllowedBrowserOrigin } from './security.js';

type Socket = {
  readyState: number;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: { toString(): string }) => void): void;
  on(event: 'close', listener: () => void): void;
};

const SESSION_REVALIDATION_INTERVAL_MS = 30_000;

export class RealtimeHub implements EventPublisher {
  private readonly topics = new Map<string, Set<Socket>>();
  private readonly sessionSockets = new Map<string, Set<Socket>>();
  private publishedEvents = 0;
  private deliveredMessages = 0;
  private lastFanoutDurationMs = 0;

  publish(topic: string, event: RealtimeEvent): void {
    const startedAt = performance.now();
    const payload = JSON.stringify({ event, topic });
    for (const socket of this.topics.get(topic) ?? []) {
      if (socket.readyState === 1) {
        socket.send(payload);
        this.deliveredMessages += 1;
      }
    }
    this.publishedEvents += 1;
    this.lastFanoutDurationMs = performance.now() - startedAt;
  }

  subscribe(socket: Socket, topic: string): void {
    const sockets = this.topics.get(topic) ?? new Set<Socket>();
    sockets.add(socket);
    this.topics.set(topic, sockets);
  }

  bindSession(socket: Socket, sessionId: string): void {
    const sockets = this.sessionSockets.get(sessionId) ?? new Set<Socket>();
    sockets.add(socket);
    this.sessionSockets.set(sessionId, sockets);
  }

  disconnectSession(sessionId: string, reason: string): void {
    for (const socket of this.sessionSockets.get(sessionId) ?? []) {
      if (socket.readyState === 1)
        socket.send(
          JSON.stringify({
            error: {
              code: 'AUTHENTICATION_REQUIRED',
              message: 'The session is no longer valid.',
            },
          }),
        );
      socket.close(4401, reason);
      this.remove(socket);
    }
    this.sessionSockets.delete(sessionId);
  }

  unsubscribe(socket: Socket, topic: string): void {
    const sockets = this.topics.get(topic);
    sockets?.delete(socket);
    if (sockets?.size === 0) this.topics.delete(topic);
  }

  remove(socket: Socket): void {
    for (const [topic, sockets] of this.topics) {
      sockets.delete(socket);
      if (sockets.size === 0) this.topics.delete(topic);
    }
    for (const [sessionId, sockets] of this.sessionSockets) {
      sockets.delete(socket);
      if (sockets.size === 0) this.sessionSockets.delete(sessionId);
    }
  }

  subscriberCount(topic?: string): number {
    if (topic) return this.topics.get(topic)?.size ?? 0;
    return new Set([...this.topics.values()].flatMap((sockets) => [...sockets])).size;
  }

  getMetrics() {
    return {
      subscriberCount: this.subscriberCount(),
      topicCount: this.topics.size,
      publishedEvents: this.publishedEvents,
      deliveredMessages: this.deliveredMessages,
      lastFanoutDurationMs: this.lastFanoutDurationMs,
    };
  }
}

export function registerRealtime(
  app: FastifyInstance,
  dependencies: {
    hub: RealtimeHub;
    authorization: AuthorizationService;
    authentication: AuthenticationService;
    rateLimiter: RateLimiter;
    allowedOrigins: readonly string[];
  },
): void {
  app.get(
    '/v1/realtime',
    {
      websocket: true,
      preValidation: async (request) => {
        assertAllowedBrowserOrigin(request, dependencies.allowedOrigins);
        await dependencies.rateLimiter.consume(
          'ws-connect',
          request.ip,
          RATE_LIMITS.websocketConnections,
        );
      },
    },
    (rawSocket, request) => {
      const socket = rawSocket as Socket;
      let sessionValidationTimer: NodeJS.Timeout | null = null;
      let sessionExpirationTimer: NodeJS.Timeout | null = null;
      if (request.authenticatedSession) {
        const sessionId = request.authenticatedSession.id;
        const expiresAt = request.authenticatedSession.expiresAt.getTime();
        dependencies.hub.bindSession(socket, request.authenticatedSession.id);
        const scheduleExpiration = () => {
          const remaining = expiresAt - Date.now();
          if (remaining <= 0) {
            dependencies.hub.disconnectSession(sessionId, 'Session expired');
            return;
          }
          sessionExpirationTimer = setTimeout(
            scheduleExpiration,
            Math.min(remaining, 2_147_000_000),
          );
          sessionExpirationTimer.unref();
        };
        scheduleExpiration();
        sessionValidationTimer = setInterval(() => {
          if (
            request.authenticatedSession &&
            request.authenticatedSession.expiresAt.getTime() <= Date.now()
          ) {
            dependencies.hub.disconnectSession(sessionId, 'Session expired');
            return;
          }
          void dependencies.authentication
            .resolveSession(sessionId)
            .then((session) => {
              if (session) {
                request.authenticatedSession = session;
                request.authenticatedUser = session.user;
                return;
              }
              dependencies.hub.disconnectSession(sessionId, 'Session expired');
            })
            .catch(() => {
              // A connectivity failure is retried and never converted into an authentication loss.
            });
        }, SESSION_REVALIDATION_INTERVAL_MS);
        sessionValidationTimer.unref();
      }
      socket.send(
        JSON.stringify({
          type: 'connection.ready',
          requestId: request.id,
          resync:
            'Fetch a REST snapshot after every reconnect, then subscribe for incremental updates.',
        }),
      );

      socket.on('message', (data) => {
        void handleMessage(socket, request, data.toString(), dependencies);
      });
      socket.on('close', () => {
        if (sessionValidationTimer) clearInterval(sessionValidationTimer);
        if (sessionExpirationTimer) clearTimeout(sessionExpirationTimer);
        dependencies.hub.remove(socket);
      });
    },
  );
}

async function handleMessage(
  socket: Socket,
  request: FastifyRequest,
  raw: string,
  dependencies: {
    hub: RealtimeHub;
    authorization: AuthorizationService;
    authentication: AuthenticationService;
    rateLimiter: RateLimiter;
    allowedOrigins: readonly string[];
  },
): Promise<void> {
  try {
    await dependencies.rateLimiter.consume(
      'ws-subscription',
      request.authenticatedUser?.id ?? request.ip,
      RATE_LIMITS.websocketSubscriptions,
    );
    const parsed = realtimeSubscriptionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error('Malformed subscription message');
    const { action, topic } = parsed.data;
    if (topic.startsWith('entry:')) {
      const session = await dependencies.authentication.resolveSession(
        request.authenticatedSession?.id,
      );
      request.authenticatedSession = session;
      request.authenticatedUser = session?.user ?? null;
      const user = requireUser(request);
      await dependencies.authorization.canReadEntry(user.id, topic.slice('entry:'.length));
    }
    if (
      topic.startsWith('market:') &&
      !SUPPORTED_SYMBOLS.some((symbol) => topic === `market:${symbol}`)
    )
      throw new Error('Unsupported market topic');
    if (action === 'subscribe') dependencies.hub.subscribe(socket, topic);
    else dependencies.hub.unsubscribe(socket, topic);
    socket.send(JSON.stringify({ type: 'subscription.acknowledged', action, topic }));
  } catch (error) {
    const normalized = normalizeError(error);
    socket.send(
      JSON.stringify({
        error: {
          code: normalized.code === 'INTERNAL_ERROR' ? 'INVALID_SUBSCRIPTION' : normalized.code,
          message:
            normalized.code === 'INTERNAL_ERROR'
              ? 'Malformed or unsupported subscription.'
              : normalized.message,
          requestId: request.id,
        },
      }),
    );
  }
}

export function connectMarketRealtime(
  market: ObservableMarketPriceProvider & Partial<MarketDataProvider>,
  hub: RealtimeHub,
  leaderboards: LeaderboardService,
  processOrders:
    ((symbol: Parameters<MarketPriceProvider['getSnapshot']>[0]) => Promise<unknown>) | null = null,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  const unsubscribeEvents = market.subscribeMarketEvents?.((event) => {
    if (event.type === 'provider') return;
    if (event.type === 'price') {
      const visible = event.view.exchangePrice ?? event.view.authoritativeMark;
      if (!visible) return;
      hub.publish(`market:${event.view.symbol}`, {
        type: 'market.price',
        symbol: event.view.symbol,
        price: priceToString(visible.price),
        markPrice: event.view.authoritativeMark
          ? priceToString(event.view.authoritativeMark.price)
          : null,
        marketTimestamp: visible.marketTimestamp.toISOString(),
        markTimestamp: event.view.authoritativeMark?.marketTimestamp.toISOString() ?? null,
        source: visible.source,
        markSource: event.view.authoritativeMark?.source ?? null,
        status: event.view.status,
        exchangeStatus: event.view.exchangeStatus,
      });
      return;
    }
    if (event.type === 'book') {
      hub.publish(`market:${event.book.symbol}`, {
        type: 'market.book',
        symbol: event.book.symbol,
        venue: event.book.venue,
        status: event.book.status,
        timestamp: event.book.timestamp?.toISOString() ?? null,
        bids: event.book.bids.map((level) => ({
          price: priceToString(level.price),
          quantity: quantityToString(level.quantity),
          total: quantityToString(level.total),
        })),
        asks: event.book.asks.map((level) => ({
          price: priceToString(level.price),
          quantity: quantityToString(level.quantity),
          total: quantityToString(level.total),
        })),
        spread: event.book.spread ? decimalToString(event.book.spread) : null,
        spreadBasisPoints: event.book.spreadBasisPoints?.toString() ?? null,
      });
      return;
    }
    if (event.type === 'trades') {
      hub.publish(`market:${event.symbol}`, {
        type: 'market.trades',
        symbol: event.symbol,
        trades: event.trades.map((trade) => ({
          id: trade.id,
          price: priceToString(trade.price),
          quantity: quantityToString(trade.quantity),
          side: trade.side,
          timestamp: trade.timestamp.toISOString(),
          venue: trade.venue,
        })),
      });
      return;
    }
    if (event.type === 'candle') {
      hub.publish(`market:${event.symbol}`, {
        type: 'market.candle',
        symbol: event.symbol,
        interval: event.interval,
        candle: {
          timestamp: event.candle.timestamp.toISOString(),
          open: priceToString(event.candle.open),
          high: priceToString(event.candle.high),
          low: priceToString(event.candle.low),
          close: priceToString(event.candle.close),
          volume: event.candle.volume ? quantityToString(event.candle.volume) : null,
        },
      });
      return;
    }
    if (event.type === 'status')
      hub.publish(`market:${event.symbol}`, {
        type: 'market.status',
        symbol: event.symbol,
        status: event.status,
      });
  });
  const unsubscribePrices = market.subscribe((snapshot) => {
    if (!market.subscribeMarketEvents)
      hub.publish(`market:${snapshot.symbol}`, {
        type: 'market.price',
        symbol: snapshot.symbol,
        price: priceToString(snapshot.price),
        markPrice: priceToString(snapshot.price),
        marketTimestamp: snapshot.marketTimestamp.toISOString(),
        markTimestamp: snapshot.marketTimestamp.toISOString(),
        source: snapshot.source,
        markSource: snapshot.source,
        status: snapshot.status ?? 'LIVE',
        exchangeStatus: snapshot.status ?? 'LIVE',
      });
    void (async () => {
      if (processOrders)
        try {
          await processOrders(snapshot.symbol);
        } catch (error) {
          onError(error);
        }
      try {
        await leaderboards.refreshSymbol(snapshot.symbol);
      } catch (error) {
        onError(error);
      }
    })();
  });
  return () => {
    unsubscribeEvents?.();
    unsubscribePrices();
  };
}
