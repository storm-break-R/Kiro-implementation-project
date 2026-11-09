import './config/dotenv.js';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { createApp, getScheduler } from './app.js';
import { loadEnv } from './config/env.js';
import { createRedis } from './infra/redis.js';
import { createStorage } from './infra/storage.js';
import { syncIndexes } from './models/index.js';
import { ResultsHub, createRealtime } from './realtime/hub.js';

async function main(): Promise<void> {
  const env = loadEnv();

  // Wait up to 60s so `npm run dev` can start the API while the dev DB is still booting.
  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 60_000 });
  await syncIndexes();
  const redis = createRedis(env.REDIS_URL);
  console.log(`Redis mode: ${redis.kind}`);
  const storage = createStorage(env);
  console.log(`Image storage: ${storage.kind}`);

  const hub = new ResultsHub();
  const app = createApp({
    env,
    redis,
    storage,
    hub,
    healthChecks: [
      {
        name: 'mongo',
        check: async () => {
          await mongoose.connection.db?.admin().ping();
        },
      },
      {
        name: 'redis',
        check: async () => {
          await redis.client.ping();
        },
      },
    ],
  });

  const server = createServer(app);
  const io = createRealtime(server, hub, { clientOrigin: env.CLIENT_ORIGIN, redis });

  const scheduler = getScheduler(app);
  scheduler.start();
  void scheduler.tick(); // close anything that expired while the server was down

  server.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
  });

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    hub.close();
    await io.close();
    redis.client.disconnect();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
