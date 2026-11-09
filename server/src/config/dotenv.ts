import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

/**
 * npm workspaces run server scripts with `server/` as the working directory, so a plain
 * `dotenv/config` would miss the repo-root .env. Load the root file first, then server/.env.
 * Variables already set in the real environment always win (dotenv never overrides them).
 */
for (const file of [path.resolve(process.cwd(), '../.env'), path.resolve(process.cwd(), '.env')]) {
  if (existsSync(file)) config({ path: file, quiet: true });
}
