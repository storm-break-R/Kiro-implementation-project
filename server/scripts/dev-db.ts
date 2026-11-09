/**
 * Local development MongoDB: an embedded single-node replica set (needed for transactions),
 * persisted under DATA_DIR/mongo so data survives restarts. No Docker or install required.
 * The first run downloads a MongoDB binary.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const port = Number(process.env.MONGO_PORT ?? 27017);
const dbPath = path.resolve(process.env.DATA_DIR ?? './.data', 'mongo');
mkdirSync(dbPath, { recursive: true });

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, name: 'rs0', storageEngine: 'wiredTiger' },
  instanceOpts: [{ port, dbPath, storageEngine: 'wiredTiger', launchTimeout: 90_000 }],
});

console.log(`MongoDB ready: mongodb://127.0.0.1:${port}/soccer_voting?directConnection=true`);
console.log(`Data directory: ${dbPath}`);

const stop = async (): Promise<void> => {
  await replSet.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
