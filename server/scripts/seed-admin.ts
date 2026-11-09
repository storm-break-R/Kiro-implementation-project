/** Usage: set ADMIN_EMAIL and ADMIN_PASSWORD (in .env or the shell), then `npm run seed -w server`. */
import '../src/config/dotenv.js';
import mongoose from 'mongoose';
import { loadEnv } from '../src/config/env.js';
import { syncIndexes } from '../src/models/index.js';
import { verifyAuditChain } from '../src/services/audit.js';
import { seedAdmin } from '../src/services/seed.js';

const env = loadEnv();
await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 15_000 });
await syncIndexes();

const result = await seedAdmin(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
console.log(
  result.created
    ? `Created admin ${result.email}. Log in, then enroll TOTP MFA.`
    : `An admin already exists (${result.email}). Nothing to do.`,
);
const chain = await verifyAuditChain();
console.log(`Audit chain: ${chain.valid ? 'valid' : 'BROKEN'} (${chain.checked} entries)`);
await mongoose.disconnect();
