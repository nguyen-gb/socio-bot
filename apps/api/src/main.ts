import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JsonLogger } from './common/json-logger';
import type { ApiEnvironment } from './config/environment';
import type { NextFunction, Request, Response } from 'express';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  const config = app.get(ConfigService<ApiEnvironment, true>);
  app.useLogger(new JsonLogger());

  app.setGlobalPrefix('api');
  app.use((request: Request, response: Response, next: NextFunction) => {
    const candidate = request.header('x-request-id');
    const requestId = candidate && /^[a-zA-Z0-9._-]{8,128}$/.test(candidate)
      ? candidate
      : randomUUID();
    response.setHeader('x-request-id', requestId);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');
    next();
  });
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();

  await app.listen(config.get('port', { infer: true }), '0.0.0.0');
}

void bootstrap();
