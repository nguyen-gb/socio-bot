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
  /** Time to leave Chromium open after an action result before closing it. */
  browserCloseDelayMs: number;
  browserChannel?: string;
  browserLocale?: string;
  browserTimezoneId?: string;
  /** Search provider used by TikTok product tests; live is the production-safe default. */
  tiktokSearchMode: 'live' | 'fixture';
  tiktokSearchFixtureScenario: 'success' | 'empty' | 'challenge';
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
  const tiktokSearchMode = enumValue(
    process.env.TIKTOK_SEARCH_MODE,
    ['live', 'fixture'] as const,
    'live',
  );
  const tiktokSearchFixtureScenario = enumValue(
    process.env.TIKTOK_SEARCH_FIXTURE_SCENARIO,
    ['success', 'empty', 'challenge'] as const,
    'success',
  );
  if (nodeEnv === 'production' && tiktokSearchMode === 'fixture') {
    throw new Error('TIKTOK_SEARCH_MODE=fixture is only allowed outside production');
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
    // Keep the execution mode deterministic by deployment environment while
    // allowing an explicit deployment override when a local worker should use
    // the same headed Chrome surface as a manually opened browser.
    browserHeadless: booleanValue(
      process.env.BROWSER_HEADLESS,
      nodeEnv === 'production',
    ),
    // Give Facebook's UI a short settling window after submit/confirmation
    // and before profile teardown. Override per deployment when a slower
    // connection needs more time (for example BROWSER_CLOSE_DELAY_MS=10000).
    browserCloseDelayMs: positiveInteger(process.env.BROWSER_CLOSE_DELAY_MS, 5_000),
    browserChannel: optionalString(process.env.BROWSER_CHANNEL),
    browserLocale: browserLocale(process.env.BROWSER_LOCALE),
    browserTimezoneId: browserTimezone(process.env.BROWSER_TIMEZONE_ID),
    tiktokSearchMode,
    tiktokSearchFixtureScenario,
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
      // Keep the local fallback aligned with docker/.env.example so a worker
      // started from its package directory still polls the API's queue.
      process.env.TEMPORAL_TASK_QUEUE ?? 'browser-automation',
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

function optionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function enumValue<const T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  const resolved = value ?? fallback;
  if (!allowed.includes(resolved)) {
    throw new Error(`Expected one of ${allowed.join(', ')}, received ${resolved}`);
  }
  return resolved as T[number];
}

/** Fail fast on invalid standard browser settings instead of repeatedly
 * failing task launches and retrying a broken configuration. */
function browserLocale(value: string | undefined): string | undefined {
  const locale = optionalString(value);
  if (!locale) return undefined;
  try { return Intl.getCanonicalLocales(locale)[0]; }
  catch { throw new Error(`Invalid BROWSER_LOCALE: ${locale}`); }
}

function browserTimezone(value: string | undefined): string | undefined {
  const timezone = optionalString(value);
  if (!timezone) return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
  catch { throw new Error(`Invalid BROWSER_TIMEZONE_ID: ${timezone}`); }
  return timezone;
}
