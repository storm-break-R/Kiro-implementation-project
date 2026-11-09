import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

// Development-only defaults. Production refuses to start with any of these.
export const DEV_JWT_SECRET = 'dev-only-jwt-secret-change-me-please-0123456789';
export const DEV_CODE_PEPPER = 'dev-only-code-pepper-change-me-please-0123456789';
export const DEV_ENCRYPTION_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

    // MongoDB. Must be a replica set (transactions). Dev default points at `npm run dev:db`.
    MONGO_URI: z
      .string()
      .min(1)
      .default('mongodb://127.0.0.1:27017/soccer_voting?directConnection=true'),

    // Redis. If REDIS_URL is unset, an in-memory implementation is used (single process only).
    REDIS_URL: optionalString,

    // Image storage. If S3_BUCKET is unset, images are stored on local disk under DATA_DIR.
    DATA_DIR: z.string().default('./.data'),
    S3_BUCKET: optionalString,
    S3_REGION: z.string().default('us-east-1'),
    S3_ENDPOINT: optionalString,
    S3_ACCESS_KEY: optionalString,
    S3_SECRET_KEY: optionalString,

    // Secrets
    JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
    CODE_PEPPER: z.string().min(32).default(DEV_CODE_PEPPER),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)')
      .default(DEV_ENCRYPTION_KEY),

    // Number of reverse proxies in front of the API (ALB/CloudFront = 1+), for correct client IPs.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),

    // Seeded first admin
    ADMIN_EMAIL: optionalString,
    ADMIN_PASSWORD: optionalString,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    const defaults: Array<[keyof typeof env, string]> = [
      ['JWT_SECRET', DEV_JWT_SECRET],
      ['CODE_PEPPER', DEV_CODE_PEPPER],
      ['ENCRYPTION_KEY', DEV_ENCRYPTION_KEY],
    ];
    for (const [key, devValue] of defaults) {
      if (env[key] === devValue) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must be set to a unique secret in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Parse and validate environment variables. Throws a readable error if invalid. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // `KEY=` lines (as in .env.example) mean "not set": use the default instead of failing.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return result.data;
}
