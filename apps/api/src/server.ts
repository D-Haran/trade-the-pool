import { buildApp } from './app.js';
import { config } from './config.js';
import { createDatabase } from '@trade-the-pool/database';
import {
  DeterministicMarketPriceSource,
  createLiveMarketDataService,
  type MarketSymbol,
} from '@trade-the-pool/market-data';
import { RedisKeyValueStore } from './infrastructure.js';
import { RealtimeHub, connectMarketRealtime } from './realtime.js';
import { AccountSnapshotService, LeaderboardService, TradingApiService } from './services.js';
import { settleDueTournaments } from '@trade-the-pool/trading-engine';

const connection = createDatabase(config.DATABASE_URL);
const store = new RedisKeyValueStore(config.REDIS_URL);
await store.connect();
const market =
  config.MARKET_DATA_MODE === 'live'
    ? createLiveMarketDataService({
        mode: 'live',
        krakenWsUrl: config.KRAKEN_WS_URL,
        krakenRestUrl: config.KRAKEN_REST_URL,
        coinbaseWsUrl: config.COINBASE_WS_URL,
        pythHermesUrl: config.PYTH_HERMES_URL,
        pythApiKey: config.PYTH_API_KEY,
        pythFeedIds: {
          'BTC-USD': config.PYTH_FEED_ID_BTC_USD!,
          'ETH-USD': config.PYTH_FEED_ID_ETH_USD!,
          'SOL-USD': config.PYTH_FEED_ID_SOL_USD!,
        } satisfies Record<MarketSymbol, string>,
        freshness: {
          authoritativeDelayedMs: config.MARKET_AUTHORITATIVE_DELAYED_MS,
          authoritativeStaleMs: config.MARKET_AUTHORITATIVE_STALE_MS,
          exchangeDelayedMs: config.MARKET_EXCHANGE_DELAYED_MS,
          exchangeStaleMs: config.MARKET_EXCHANGE_STALE_MS,
          bookStaleMs: config.MARKET_BOOK_STALE_MS,
          comparisonStaleMs: config.MARKET_COMPARISON_STALE_MS,
          maximumDeviationBasisPoints: config.MARKET_MAX_DEVIATION_BPS,
        },
      })
    : new DeterministicMarketPriceSource();
if ('start' in market) market.start();
const hub = new RealtimeHub();
const snapshots = new AccountSnapshotService(connection.db, market);
const leaderboards = new LeaderboardService(connection.db, snapshots, store, hub);
const trading = new TradingApiService(connection.db, market, snapshots, leaderboards, hub);
let disconnectMarket: () => void = () => undefined;
let disconnectMarketObservability: () => void = () => undefined;
let settlementTimer: NodeJS.Timeout | null = null;
const app = await buildApp({
  db: connection.db,
  market,
  store,
  config,
  hub,
  trading,
  close: async () => {
    disconnectMarket();
    disconnectMarketObservability();
    if (settlementTimer) clearInterval(settlementTimer);
    if ('close' in market) await market.close();
    await store.close();
    await connection.client.end();
  },
});
const initialMarketHealth = market.getHealth();
app.log.info(
  {
    marketDataMode: initialMarketHealth.mode,
    components: initialMarketHealth.components,
    symbolMappings: initialMarketHealth.symbolMappings,
    providers: initialMarketHealth.providers.map(({ provider, connection }) => ({
      provider,
      connection,
    })),
  },
  'market data configuration selected',
);
disconnectMarket = connectMarketRealtime(
  market,
  hub,
  leaderboards,
  (symbol) => trading.processMarketTick(symbol),
  (error) => app.log.error({ err: error }, 'market projection refresh failed'),
);
if ('subscribeMarketEvents' in market) {
  const loggedStatuses = new Map<MarketSymbol, string>();
  const loggedProviderConnections = new Map<string, string>();
  disconnectMarketObservability = market.subscribeMarketEvents((event) => {
    if (event.type === 'provider') {
      const prior = loggedProviderConnections.get(event.health.provider);
      if (prior === event.health.connection) return;
      loggedProviderConnections.set(event.health.provider, event.health.connection);
      const fields = {
        marketDataMode: 'live',
        provider: event.health.provider,
        connection: event.health.connection,
        reconnectCount: event.health.reconnectCount,
        orderBookResyncCount: event.health.orderBookResyncCount,
        lastMessageAt: event.health.lastMessageAt,
        lastValidPriceAt: event.health.lastValidPriceAt,
        lastBookUpdateAt: event.health.lastBookUpdateAt,
        lastTradeAt: event.health.lastTradeAt,
        error: event.health.lastError,
      };
      if (event.health.connection === 'CONNECTED')
        app.log.info(fields, 'market data provider connected');
      else app.log.warn(fields, 'market data provider state changed');
      return;
    }
    if (event.type !== 'price' && event.type !== 'status') return;
    const symbol = event.type === 'price' ? event.view.symbol : event.symbol;
    const view = market.getMarketView(symbol);
    if (loggedStatuses.get(symbol) === view.status) return;
    loggedStatuses.set(symbol, view.status);
    const fields = {
      symbol,
      status: view.status,
      exchangeStatus: view.exchangeStatus,
      availability: view.availability,
      deviationBasisPoints: view.deviationBasisPoints?.toString() ?? null,
      authoritativeSource: view.authoritativeMark?.source ?? null,
      authoritativeTimestamp: view.authoritativeMark?.marketTimestamp ?? null,
      exchangeSource: view.exchangePrice?.source ?? null,
      exchangeTimestamp: view.exchangePrice?.marketTimestamp ?? null,
    };
    if (view.status === 'LIVE') app.log.info(fields, 'market data recovered');
    else app.log.warn(fields, 'market data state changed');
  });
}
let settlementRunning = false;
settlementTimer = setInterval(() => {
  if (settlementRunning) return;
  settlementRunning = true;
  void settleDueTournaments(connection.db, market)
    .then(async (results) => {
      for (const result of results) {
        await leaderboards.rebuild(result.tournamentId);
        hub.publish(`tournament:${result.tournamentId}`, {
          type: 'tournament.status_changed',
          tournamentId: result.tournamentId,
          status: 'COMPLETED',
        });
        app.log.info(
          {
            tournamentId: result.tournamentId,
            entryCount: result.entryIds.length,
            symbols: Object.keys(result.settlementMarks),
          },
          'tournament settlement completed',
        );
      }
    })
    .catch((error) => app.log.warn({ err: error }, 'due tournament settlement deferred'))
    .finally(() => {
      settlementRunning = false;
    });
}, 15_000);
settlementTimer.unref();

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
