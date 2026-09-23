export interface ApiEnvironment {
  nodeEnv: string;
  port: number;
  controlApiKey: string;
  remoteSessionSecret: string;
  accessTokenSecret: string;
  profileEncryptionKey: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  objectStorageRoot: string;
  objectStorageDriver: 'local' | 's3';
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3ForcePathStyle: boolean;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  allowPrivateProxyHosts: boolean;
}

export function loadEnvironment(): ApiEnvironment {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const controlApiKey =
    process.env.CONTROL_API_KEY ??
    (nodeEnv === 'development' ? 'local-development-key-change-me' : '');

  if (controlApiKey.length < 24) {
    throw new Error('CONTROL_API_KEY must contain at least 24 characters');
  }
  const remoteSessionSecret =
    process.env.REMOTE_SESSION_SECRET ??
    (nodeEnv === 'development'
      ? 'local-remote-session-secret-change-me'
      : '');
  if (remoteSessionSecret.length < 32) {
    throw new Error('REMOTE_SESSION_SECRET must contain at least 32 characters');
  }
  const accessTokenSecret =
    process.env.ACCESS_TOKEN_SECRET ??
    (nodeEnv === 'development' ? 'local-access-token-secret-change-me-now' : '');
  if (accessTokenSecret.length < 32) {
    throw new Error('ACCESS_TOKEN_SECRET must contain at least 32 characters');
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
    port: parsePositiveInteger(process.env.API_PORT, 3001, 'API_PORT'),
    controlApiKey,
    remoteSessionSecret,
    accessTokenSecret,
    profileEncryptionKey,
    accessTokenTtlSeconds: parsePositiveInteger(
      process.env.ACCESS_TOKEN_TTL_SECONDS,
      3_600,
      'ACCESS_TOKEN_TTL_SECONDS',
    ),
    refreshTokenTtlDays: parsePositiveInteger(
      process.env.REFRESH_TOKEN_TTL_DAYS,
      30,
      'REFRESH_TOKEN_TTL_DAYS',
    ),
    objectStorageRoot: process.env.OBJECT_STORAGE_ROOT ?? './object-storage',
    objectStorageDriver,
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
    allowPrivateProxyHosts: booleanValue(
      process.env.ALLOW_PRIVATE_PROXY_HOSTS,
      false,
      'ALLOW_PRIVATE_PROXY_HOSTS',
    ),
  };
}

function booleanValue(
  value: string | undefined,
  fallback: boolean,
  name = 'S3_FORCE_PATH_STYLE',
): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
