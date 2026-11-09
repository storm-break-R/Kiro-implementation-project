import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  NoSuchKey,
} from '@aws-sdk/client-s3';
import type { Env } from '../config/env.js';

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface ImageStorage {
  readonly kind: 'local' | 's3' | 'memory';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
const TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Keys are generated server-side; this guards every storage call against path tricks. */
export const IMAGE_KEY_PATTERN = /^candidates\/[a-f0-9-]{36}\.(jpg|png|webp)$/;

export function contentTypeForKey(key: string): string | undefined {
  return TYPE_BY_EXT[key.split('.').pop() ?? ''];
}

/** Identify an image by its magic bytes. Never trust the client-supplied MIME type or name. */
export function sniffImageType(buf: Buffer): keyof typeof EXT_BY_TYPE | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function newImageKey(type: keyof typeof EXT_BY_TYPE): string {
  return `candidates/${randomUUID()}.${EXT_BY_TYPE[type]}`;
}

function assertKey(key: string): void {
  if (!IMAGE_KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
}

export class MemoryStorage implements ImageStorage {
  readonly kind = 'memory' as const;
  readonly objects = new Map<string, StoredObject>();

  async put(key: string, body: Buffer, contentType: string) {
    assertKey(key);
    this.objects.set(key, { body, contentType });
  }
  async get(key: string) {
    assertKey(key);
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    assertKey(key);
    this.objects.delete(key);
  }
}

export class LocalDiskStorage implements ImageStorage {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.resolve(dataDir, 'uploads');
  }

  private resolve(key: string): string {
    assertKey(key);
    return path.join(this.root, ...key.split('/'));
  }

  async put(key: string, body: Buffer) {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async get(key: string) {
    try {
      const body = await readFile(this.resolve(key));
      return { body, contentType: contentTypeForKey(key) ?? 'application/octet-stream' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string) {
    await rm(this.resolve(key), { force: true });
  }
}

export class S3Storage implements ImageStorage {
  readonly kind = 's3' as const;
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    opts: { region: string; endpoint?: string; accessKey?: string; secretKey?: string },
  ) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
      // Without explicit keys the SDK uses the default chain (e.g. the ECS task role).
      ...(opts.accessKey && opts.secretKey
        ? { credentials: { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey } }
        : {}),
    });
  }

  async put(key: string, body: Buffer, contentType: string) {
    assertKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async get(key: string) {
    assertKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) return null;
      return {
        body: Buffer.from(bytes),
        contentType: res.ContentType ?? contentTypeForKey(key) ?? 'application/octet-stream',
      };
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }

  async delete(key: string) {
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** S3 when S3_BUCKET is set, otherwise local disk under DATA_DIR. */
export function createStorage(env: Env): ImageStorage {
  if (env.S3_BUCKET) {
    return new S3Storage(env.S3_BUCKET, {
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
    });
  }
  return new LocalDiskStorage(env.DATA_DIR);
}
