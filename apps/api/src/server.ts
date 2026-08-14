import { buildApp } from './app.js';
import { config } from './config.js';
import { createDatabase } from '@trade-the-pool/database';
import { DeterministicMarketPriceSource } from '@trade-the-pool/market-data';
import { RedisKeyValueStore } from './infrastructure.js';
import { RealtimeHub, connectMarketRealtime } from './realtime.js';
import { AccountSnapshotService, LeaderboardService } from './services.js';

const connection = createDatabase(config.DATABASE_URL);
const store = new RedisKeyValueStore(config.REDIS_URL);
await store.connect();
const market = new DeterministicMarketPriceSource();
const hub = new RealtimeHub();
const snapshots = new AccountSnapshotService(connection.db, market);
const leaderboards = new LeaderboardService(connection.db, snapshots, store, hub);
let disconnectMarket: () => void = () => undefined;
const app = await buildApp({
  db: connection.db,
  market,
  store,
  config,
  hub,
  close: async () => {
    disconnectMarket();
    await store.close();
    await connection.client.end();
  },
});
disconnectMarket = connectMarketRealtime(market, hub, leaderboards, (error) =>
  app.log.error({ err: error }, 'market projection refresh failed'),
);

try {
  await app.listen({ host: '0.0.0.0', port: config.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
