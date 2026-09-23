import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import type { ObjectStorage } from './object-storage';

export interface SnapshotResult {
  storageUri: string;
  sizeBytes: number;
  checksum: string;
}

export class ProfileSnapshotStore {
  constructor(
    private readonly objects: ObjectStorage,
    private readonly profileRoot: string,
    private readonly tempRoot: string,
    private readonly encryptionKey: Buffer,
  ) {
    if (encryptionKey.length !== 32) {
      throw new Error('Profile snapshot encryption key must be exactly 32 bytes');
    }
  }

  async snapshot(profileId: string, version: number): Promise<SnapshotResult> {
    const profilePath = safeProfilePath(this.profileRoot, profileId);
    const workspace = resolve(this.tempRoot, `snapshot-${randomUUID()}`);
    const archivePath = resolve(workspace, 'profile.tar.gz');
    const encryptedPath = resolve(workspace, 'profile.tar.gz.enc');
    await mkdir(workspace, { recursive: true });

    try {
      await tar.c({ cwd: profilePath, file: archivePath, gzip: true }, ['.']);
      const { iv, tag } = await encryptFile(archivePath, encryptedPath, this.encryptionKey);
      const checksum = await sha256File(encryptedPath);
      const stored = await this.objects.putFile(
        `profiles/${profileId}/snapshots/${version.toString()}.tar.gz.enc`,
        encryptedPath,
        'application/octet-stream',
      );
      const metadata = new URLSearchParams({
        v: '1',
        iv: iv.toString('base64url'),
        tag: tag.toString('base64url'),
      });
      return {
        storageUri: `${stored.uri}#${metadata.toString()}`,
        sizeBytes: stored.sizeBytes,
        checksum,
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  async restore(profileId: string, storageUri?: string | null): Promise<void> {
    const profilePath = safeProfilePath(this.profileRoot, profileId);
    if (!storageUri) {
      await mkdir(profilePath, { recursive: true });
      return;
    }

    const uri = new URL(storageUri);
    const iv = Buffer.from(requiredFragment(uri, 'iv'), 'base64url');
    const tag = Buffer.from(requiredFragment(uri, 'tag'), 'base64url');
    uri.hash = '';

    const workspace = resolve(this.tempRoot, `restore-${randomUUID()}`);
    const encryptedPath = resolve(workspace, 'profile.tar.gz.enc');
    const archivePath = resolve(workspace, 'profile.tar.gz');
    await mkdir(workspace, { recursive: true });

    try {
      await this.objects.getFile(uri.toString(), encryptedPath);
      await decryptFile(encryptedPath, archivePath, this.encryptionKey, iv, tag);
      await rm(profilePath, { recursive: true, force: true });
      await mkdir(profilePath, { recursive: true });
      await tar.x({ cwd: profilePath, file: archivePath, strict: true });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export function parseProfileEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('PROFILE_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  return key;
}

async function encryptFile(source: string, destination: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  await pipeline(createReadStream(source), cipher, createWriteStream(destination));
  return { iv, tag: cipher.getAuthTag() };
}

async function decryptFile(
  source: string,
  destination: string,
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
) {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(source), decipher, createWriteStream(destination));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function safeProfilePath(root: string, profileId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(profileId)) throw new Error('Invalid profile id');
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, profileId);
  if (dirname(target) !== resolvedRoot) throw new Error('Profile path escapes profile root');
  return target;
}

function requiredFragment(uri: URL, key: string): string {
  const value = new URLSearchParams(uri.hash.slice(1)).get(key);
  if (!value) throw new Error(`Snapshot URI is missing ${key}`);
  return value;
}
