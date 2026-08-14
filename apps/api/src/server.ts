import { buildApp } from './app.js';
import { config } from './config.js';
import { createDatabase } from '@trade-the-pool/database';
import { DeterministicMarketPriceSource } from '@trade-the-pool/market-data';
import { RedisKeyValueStore } from './infrastructure.js';
import { RealtimeHub, connectMarketRealtime } from './realtime.js';
import { AccountSnapshotService, LeaderboardService, TradingApiService } from './services.js';

const connection = createDatabase(config.DATABASE_URL);
const store = new RedisKeyValueStore(config.REDIS_URL);
await store.connect();
const market = new DeterministicMarketPriceSource();
const hub = new RealtimeHub();
const snapshots = new AccountSnapshotService(connection.db, market);
const leaderboards = new LeaderboardService(connection.db, snapshots, store, hub);
const trading = new TradingApiService(connection.db, market, snapshots, leaderboards, hub);
let disconnectMarket: () => void = () => undefined;
const app = await buildApp({
  db: connection.db,
  market,
  store,
  config,
  hub,
  trading,
  close: async () => {
    disconnectMarket();
    await store.close();
    await connection.client.end();
  },
});
disconnectMarket = connectMarketRealtime(
  market,
  hub,
  leaderboards,
  (symbol) => trading.processMarketTick(symbol),
  (error) => app.log.error({ err: error }, 'market projection refresh failed'),
);

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
