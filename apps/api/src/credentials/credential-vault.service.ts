import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isSealedSecret,
  parseProfileEncryptionKey,
  sealSecret,
  unsealSecret,
} from '@socio/object-storage';
import type { ApiEnvironment } from '../config/environment';

@Injectable()
export class CredentialVaultService {
  private readonly key: Buffer;

  constructor(config: ConfigService<ApiEnvironment, true>) {
    this.key = parseProfileEncryptionKey(
      config.get('profileEncryptionKey', { infer: true }),
    );
  }

  seal(value: unknown): string {
    return sealSecret(value, this.key);
  }

  profileCredentials(reference: string): {
    login?: string;
    password?: string;
    cookies?: string;
  } {
    const value = this.unseal<Record<string, unknown>>(reference);
    if (value.type === 'PASSWORD') {
      return {
        login: typeof value.login === 'string' ? value.login : undefined,
        password: typeof value.password === 'string' ? value.password : undefined,
      };
    }
    if (value.type === 'COOKIES') {
      return { cookies: typeof value.cookies === 'string' ? value.cookies : undefined };
    }
    return {
      login: typeof value.login === 'string' ? value.login : undefined,
      password: typeof value.password === 'string' ? value.password : undefined,
      cookies: typeof value.cookies === 'string' ? value.cookies : undefined,
    };
  }

  proxyCredentials(reference: string): { username: string; password: string } {
    const value = this.unseal<Partial<{ username: string; password: string }>>(reference);
    if (!value.username || !value.password) {
      throw new Error('Proxy secret must contain username and password');
    }
    return { username: value.username, password: value.password };
  }

  private unseal<T>(reference: string): T {
    if (!isSealedSecret(reference)) {
      throw new Error('Only credentials saved through the dashboard can be displayed');
    }
    return unsealSecret<T>(reference, this.key);
  }
}
