import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isSealedSecret,
  parseProfileEncryptionKey,
  unsealSecret,
} from '@socio/object-storage';
import type { WorkerEnvironment } from '../config/environment';

interface ProxyCredentials {
  username: string;
  password: string;
}

export interface ProfileCredentials {
  login?: string;
  password?: string;
  cookies?: string;
}

@Injectable()
export class SecretsService {
  private readonly root: string;
  private readonly encryptionKey: Buffer;

  constructor(config: ConfigService<WorkerEnvironment, true>) {
    this.root = resolve(config.get('secretRoot', { infer: true }));
    this.encryptionKey = parseProfileEncryptionKey(
      config.get('profileEncryptionKey', { infer: true }),
    );
  }

  async proxyCredentials(reference: string): Promise<ProxyCredentials> {
    const parsed = await this.readReference<Partial<ProxyCredentials>>(reference);
    if (!parsed.username || !parsed.password) {
      throw new Error('Proxy secret must contain username and password');
    }
    return { username: parsed.username, password: parsed.password };
  }

  async profileCredentials(reference: string): Promise<ProfileCredentials> {
    const parsed = await this.readReference<Record<string, unknown>>(reference);
    if (
      parsed.type === 'PASSWORD' &&
      typeof parsed.login === 'string' &&
      typeof parsed.password === 'string'
    ) {
      return { login: parsed.login, password: parsed.password };
    }
    if (parsed.type === 'COOKIES' && typeof parsed.cookies === 'string') {
      return { cookies: parsed.cookies };
    }
    const credentials = {
      login: typeof parsed.login === 'string' ? parsed.login : undefined,
      password: typeof parsed.password === 'string' ? parsed.password : undefined,
      cookies: typeof parsed.cookies === 'string' ? parsed.cookies : undefined,
    };
    if (Boolean(credentials.login) !== Boolean(credentials.password)) {
      throw new Error('Profile login and password must be stored together');
    }
    if (!credentials.login && !credentials.cookies) {
      throw new Error('Profile credential payload is empty');
    }
    return credentials;
  }

  private async readReference<T>(reference: string): Promise<T> {
    if (isSealedSecret(reference)) {
      return unsealSecret<T>(reference, this.encryptionKey);
    }
    const raw = reference.startsWith('env://')
      ? this.readEnvironment(reference.slice('env://'.length))
      : reference.startsWith('file://')
        ? await this.readSecretFile(reference.slice('file://'.length))
        : undefined;
    if (!raw) {
      throw new Error('Secret reference must use sealed:, env:// or file://');
    }
    return JSON.parse(raw) as T;
  }

  private readEnvironment(name: string): string {
    if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(name)) {
      throw new Error('Invalid environment secret name');
    }
    const value = process.env[name];
    if (!value) throw new Error(`Environment secret ${name} is not configured`);
    return value;
  }

  private async readSecretFile(relativePath: string): Promise<string> {
    if (!/^[a-zA-Z0-9._/-]{1,255}$/.test(relativePath)) {
      throw new Error('Invalid secret file path');
    }
    const path = resolve(this.root, relativePath);
    if (!path.startsWith(`${this.root}${sep}`)) {
      throw new Error('Secret file escapes the configured root');
    }
    return readFile(path, 'utf8');
  }
}
