import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { inject } from 'vitest';
import { syncIndexes } from '../../src/models/index.js';

/** Connect the default mongoose connection to a fresh, uniquely named database. */
export async function connectTestDb(): Promise<void> {
  const dbName = `test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await mongoose.connect(inject('mongoUri'), { dbName });
  await syncIndexes();
}

export async function disconnectTestDb(): Promise<void> {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

export async function clearCollections(): Promise<void> {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}
