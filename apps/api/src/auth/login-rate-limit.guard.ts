import { createHash } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Request } from 'express';
import type { ApiEnvironment } from '../config/environment';

const WINDOW_MS = 15 * 60 * 1_000;
const MAX_ATTEMPTS = 10;
const MAX_IP_ATTEMPTS = 100;
const INCREMENT_SCRIPT = `
local value = redis.call('incr', KEYS[1])
if value == 1 then redis.call('pexpire', KEYS[1], ARGV[1]) end
return value
`;

@Injectable()
export class LoginRateLimitGuard implements CanActivate, OnModuleDestroy {
  private readonly redis: Redis;

  constructor(config: ConfigService<ApiEnvironment, true>) {
    this.redis = new Redis(config.get('redisUrl', { infer: true }), {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const email = typeof request.body?.email === 'string'
      ? request.body.email.trim().toLowerCase()
      : 'unknown';
    const identity = createHash('sha256').update(email).digest('hex');
    try {
      // A dev hot-reload or transient Redis disconnect can leave the lazy
      // client in the terminal `end` state. Calling eval in that state makes
      // every subsequent login return 503 until the API is restarted.
      if (this.redis.status === 'wait' || this.redis.status === 'end') await this.redis.connect();
      const [ipCount, identityCount] = await Promise.all([
        this.redis.eval(INCREMENT_SCRIPT, 1, `login-rate:ip:${ip}`, WINDOW_MS.toString()),
        this.redis.eval(INCREMENT_SCRIPT, 1, `login-rate:identity:${ip}:${identity}`, WINDOW_MS.toString()),
      ]);
      if (Number(ipCount) > MAX_IP_ATTEMPTS || Number(identityCount) > MAX_ATTEMPTS) {
        throw new HttpException(
          'Too many login attempts; retry later',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Login protection is temporarily unavailable');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'wait') {
      this.redis.disconnect();
      return;
    }
    if (this.redis.status !== 'end') await this.redis.quit();
  }
}
