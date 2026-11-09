import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

let replSet: MongoMemoryReplSet | undefined;

/** One in-memory replica set shared by all test files; each file uses its own database. */
export default async function setup(project: TestProject) {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    // The default 10s is too short on slower or busy machines.
    instanceOpts: [{ launchTimeout: 90_000 }],
  });
  project.provide('mongoUri', replSet.getUri());
  return async () => {
    await replSet?.stop();
  };
}
