import {
  priceToString,
  realtimeSubscriptionSchema,
  type RealtimeEvent,
} from '@trade-the-pool/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  MarketPriceProvider,
  ObservableMarketPriceProvider,
} from '@trade-the-pool/market-data';
import { requireUser } from './auth.js';
import type { AuthorizationService } from './authorization.js';
import { normalizeError } from './errors.js';
import { RATE_LIMITS, type RateLimiter } from './infrastructure.js';
import type { EventPublisher, LeaderboardService } from './services.js';

type Socket = {
  readyState: number;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: { toString(): string }) => void): void;
  on(event: 'close', listener: () => void): void;
};

export class RealtimeHub implements EventPublisher {
  private readonly topics = new Map<string, Set<Socket>>();

  publish(topic: string, event: RealtimeEvent): void {
    const payload = JSON.stringify({ event, topic });
    for (const socket of this.topics.get(topic) ?? []) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  subscribe(socket: Socket, topic: string): void {
    const sockets = this.topics.get(topic) ?? new Set<Socket>();
    sockets.add(socket);
    this.topics.set(topic, sockets);
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
  }
}

export function registerRealtime(
  app: FastifyInstance,
  dependencies: {
    hub: RealtimeHub;
    authorization: AuthorizationService;
    rateLimiter: RateLimiter;
  },
): void {
  app.get(
    '/v1/realtime',
    {
      websocket: true,
      preValidation: async (request) =>
        dependencies.rateLimiter.consume(
          'ws-connect',
          request.ip,
          RATE_LIMITS.websocketConnections,
        ),
    },
    (rawSocket, request) => {
      const socket = rawSocket as Socket;
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
      socket.on('close', () => dependencies.hub.remove(socket));
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
    rateLimiter: RateLimiter;
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
      const user = requireUser(request);
      await dependencies.authorization.canReadEntry(user.id, topic.slice('entry:'.length));
    }
    if (
      topic.startsWith('market:') &&
      !['market:BTC-USD', 'market:ETH-USD', 'market:SOL-USD'].includes(topic)
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
  market: ObservableMarketPriceProvider,
  hub: RealtimeHub,
  leaderboards: LeaderboardService,
  processOrders:
    ((symbol: Parameters<MarketPriceProvider['getSnapshot']>[0]) => Promise<unknown>) | null = null,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  return market.subscribe((snapshot) => {
    hub.publish(`market:${snapshot.symbol}`, {
      type: 'market.price',
      symbol: snapshot.symbol,
      price: priceToString(snapshot.price),
      marketTimestamp: snapshot.marketTimestamp.toISOString(),
      source: snapshot.source,
    });
    void (async () => {
      if (processOrders) await processOrders(snapshot.symbol);
      await leaderboards.refreshSymbol(snapshot.symbol);
    })().catch(onError);
  });
}
