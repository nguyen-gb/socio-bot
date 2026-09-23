import { hostname } from 'node:os';

export interface WorkerEnvironment {
  nodeEnv: string;
  workerName: string;
  workerVersion: string;
  profileRoot: string;
  artifactRoot: string;
  objectStorageRoot: string;
  objectStorageDriver: 'local' | 's3';
  profileEncryptionKey: string;
  secretRoot: string;
  browserSlots: number;
  browserHeadless: boolean;
  redisUrl: string;
  profileLeaseTtlMs: number;
  remoteSessionPort: number;
  remoteSessionPublicUrl: string;
  remoteSessionSecret: string;
  remoteSessionRedisRelay: boolean;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3ForcePathStyle: boolean;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
}

export function loadEnvironment(): WorkerEnvironment {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const remoteSessionSecret =
    process.env.REMOTE_SESSION_SECRET ??
    (nodeEnv === 'development'
      ? 'local-remote-session-secret-change-me'
      : '');
  if (remoteSessionSecret.length < 32) {
    throw new Error('REMOTE_SESSION_SECRET must contain at least 32 characters');
  }
  const profileEncryptionKey =
    process.env.PROFILE_ENCRYPTION_KEY ??
    (nodeEnv === 'development'
      ? 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
      : '');
  if (Buffer.from(profileEncryptionKey, 'base64').length !== 32) {
    throw new Error('PROFILE_ENCRYPTION_KEY must encode exactly 32 bytes');
  }
  const objectStorageDriver = process.env.OBJECT_STORAGE_DRIVER ?? 'local';
  if (objectStorageDriver !== 'local' && objectStorageDriver !== 's3') {
    throw new Error('OBJECT_STORAGE_DRIVER must be local or s3');
  }

  return {
    nodeEnv,
    workerName:
      process.env.WORKER_NAME ?? `${hostname()}-${process.pid.toString()}`,
    workerVersion: process.env.WORKER_VERSION ?? '0.1.0',
    profileRoot: process.env.PROFILE_ROOT ?? './profiles',
    artifactRoot: process.env.ARTIFACT_ROOT ?? './artifacts',
    objectStorageRoot: process.env.OBJECT_STORAGE_ROOT ?? './object-storage',
    objectStorageDriver,
    profileEncryptionKey,
    secretRoot: process.env.SECRET_ROOT ?? './secrets',
    browserSlots: positiveInteger(process.env.BROWSER_MAX_SLOTS, 4),
    browserHeadless: booleanValue(process.env.BROWSER_HEADLESS, true),
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    profileLeaseTtlMs: positiveInteger(
      process.env.PROFILE_LEASE_TTL_MS,
      20 * 60 * 1_000,
    ),
    remoteSessionPort: positiveInteger(process.env.REMOTE_SESSION_PORT, 3010),
    remoteSessionPublicUrl:
      process.env.REMOTE_SESSION_PUBLIC_URL ?? 'ws://localhost:3010',
    remoteSessionSecret,
    remoteSessionRedisRelay: booleanValue(
      process.env.REMOTE_SESSION_REDIS_RELAY,
      false,
    ),
    s3Endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    s3Region: process.env.S3_REGION ?? 'us-east-1',
    s3Bucket: process.env.S3_BUCKET ?? 'socio-assets',
    s3AccessKey: process.env.S3_ACCESS_KEY ?? 'socio',
    s3SecretKey: process.env.S3_SECRET_KEY ?? 'replace-me',
    s3ForcePathStyle: booleanValue(process.env.S3_FORCE_PATH_STYLE, true),
    temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    temporalTaskQueue:
      process.env.TEMPORAL_TASK_QUEUE ?? 'socio-browser-tasks',
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected true or false, received ${value}`);
}
