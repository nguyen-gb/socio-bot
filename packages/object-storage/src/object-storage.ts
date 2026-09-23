import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { pipeline } from 'node:stream/promises';

export interface PutObjectResult {
  uri: string;
  sizeBytes: number;
}

export interface ObjectStorage {
  putFile(key: string, sourcePath: string, contentType: string): Promise<PutObjectResult>;
  putBytes(key: string, bytes: Uint8Array, contentType: string): Promise<PutObjectResult>;
  getFile(uri: string, destinationPath: string): Promise<void>;
  getBytes(uri: string): Promise<Uint8Array>;
}

export interface S3ObjectStorageOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private initialized?: Promise<void>;

  constructor(options: S3ObjectStorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async putFile(key: string, sourcePath: string, contentType: string) {
    await this.ensureBucket();
    const details = await stat(sourcePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: normalizeObjectKey(key),
        Body: createReadStream(sourcePath),
        ContentLength: details.size,
        ContentType: contentType,
      }),
    );
    return {
      uri: `s3://${this.bucket}/${normalizeObjectKey(key)}`,
      sizeBytes: details.size,
    };
  }

  async putBytes(key: string, bytes: Uint8Array, contentType: string) {
    await this.ensureBucket();
    const normalized = normalizeObjectKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: normalized,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: contentType,
      }),
    );
    return { uri: `s3://${this.bucket}/${normalized}`, sizeBytes: bytes.byteLength };
  }

  async getFile(uri: string, destinationPath: string): Promise<void> {
    const parsed = new URL(uri);
    if (parsed.protocol !== 's3:' || parsed.hostname !== this.bucket) {
      throw new Error(`Object URI does not belong to bucket ${this.bucket}`);
    }
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
      }),
    );
    if (!response.Body) throw new Error(`Object ${uri} has an empty response body`);
    await mkdir(dirname(destinationPath), { recursive: true });
    await pipeline(response.Body.transformToWebStream(), createWriteStream(destinationPath));
  }

  async getBytes(uri: string): Promise<Uint8Array> {
    const parsed = this.parseUri(uri);
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: parsed.key }),
    );
    if (!response.Body) throw new Error(`Object ${uri} has an empty response body`);
    return response.Body.transformToByteArray();
  }

  private ensureBucket(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        try {
          await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        } catch {
          try {
            await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
          } catch (error) {
            await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })).catch(() => {
              throw error;
            });
          }
        }
      })();
    }
    return this.initialized;
  }

  private parseUri(uri: string) {
    const parsed = new URL(uri);
    if (parsed.protocol !== 's3:' || parsed.hostname !== this.bucket) {
      throw new Error(`Object URI does not belong to bucket ${this.bucket}`);
    }
    return { key: decodeURIComponent(parsed.pathname.replace(/^\//, '')) };
  }
}

export class LocalObjectStorage implements ObjectStorage {
  constructor(private readonly root: string) {}

  async putFile(key: string, sourcePath: string, _contentType: string) {
    const destination = safeObjectPath(this.root, key);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination);
    return {
      uri: pathToFileURL(destination).toString(),
      sizeBytes: (await stat(destination)).size,
    };
  }

  async putBytes(key: string, bytes: Uint8Array, _contentType: string) {
    const destination = safeObjectPath(this.root, key);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    return { uri: pathToFileURL(destination).toString(), sizeBytes: bytes.byteLength };
  }

  async getFile(uri: string, destinationPath: string): Promise<void> {
    const safeSource = this.localPath(uri);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(safeSource, destinationPath);
  }


  async getBytes(uri: string): Promise<Uint8Array> {
    return readFile(this.localPath(uri));
  }

  private localPath(uri: string): string {
    const source = fileURLToPath(uri);
    const resolvedRoot = resolve(this.root);
    const safeSource = resolve(source);
    if (!safeSource.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error('Object URI escapes storage root');
    }
    return safeSource;
  }
}

function normalizeObjectKey(key: string): string {
  const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').includes('..')) {
    throw new Error('Invalid object key');
  }
  return normalized;
}

function safeObjectPath(root: string, key: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, normalizeObjectKey(key));
  if (!target.startsWith(`${resolvedRoot}${sep}`) && target !== resolvedRoot) {
    throw new Error('Object path escapes storage root');
  }
  return target;
}
