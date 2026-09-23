import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ObjectStorage } from '@socio/object-storage';
import type { BrowserContext, Page } from 'playwright';
import { withDeadline } from '@socio/browser-runtime';
import type { WorkerEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { OBJECT_STORAGE } from './object-storage.providers';

@Injectable()
export class TaskArtifactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<WorkerEnvironment, true>,
    @Inject(OBJECT_STORAGE) private readonly objects: ObjectStorage,
  ) {}

  async captureFailure(
    taskId: string,
    taskRunId: string,
    page: Page,
  ): Promise<void> {
    const path = resolve(
      this.config.get('artifactRoot', { infer: true }),
      `failure-${randomUUID()}.png`,
    );
    try {
      await mkdir(this.config.get('artifactRoot', { infer: true }), {
        recursive: true,
      });
      await page.screenshot({ path, fullPage: true, timeout: 5_000 });
      const stored = await this.objects.putFile(
        `artifacts/tasks/${taskId}/runs/${taskRunId}/failure.png`,
        path,
        'image/png',
      );
      await this.prisma.artifact.create({
        data: {
          taskId,
          taskRunId,
          type: 'FAILURE_SCREENSHOT',
          storageUri: stored.uri,
          contentType: 'image/png',
          sizeBytes: BigInt(stored.sizeBytes),
        },
      });
    } finally {
      await rm(path, { force: true });
    }
  }

  async temporaryPath(extension: string): Promise<string> {
    const root = this.config.get('artifactRoot', { infer: true });
    await mkdir(root, { recursive: true });
    return resolve(root, `${randomUUID()}${extension}`);
  }

  async captureScreenshot(
    taskId: string,
    taskRunId: string,
    page: Page,
    type: 'BEFORE_SCREENSHOT' | 'AFTER_SCREENSHOT',
  ): Promise<void> {
    const fileName = type === 'BEFORE_SCREENSHOT' ? 'before.png' : 'after.png';
    const path = await this.temporaryPath('.png');
    try {
      await page.screenshot({ path, fullPage: true, timeout: 5_000 });
      await this.storeFile(taskId, taskRunId, type, fileName, path, 'image/png');
    } finally {
      await rm(path, { force: true });
    }
  }

  async captureTrace(
    taskId: string,
    taskRunId: string,
    context: BrowserContext,
  ): Promise<void> {
    const path = await this.temporaryPath('.zip');
    try {
      await withDeadline(context.tracing.stop({ path }), 8_000, 'Trace capture timed out');
      await this.storeFile(
        taskId,
        taskRunId,
        'PLAYWRIGHT_TRACE',
        'trace.zip',
        path,
        'application/zip',
      );
    } finally {
      await rm(path, { force: true });
    }
  }

  async captureConsoleLog(
    taskId: string,
    taskRunId: string,
    lines: string[],
  ): Promise<void> {
    if (lines.length === 0) return;
    const bytes = Buffer.from(lines.join('\n').slice(0, 1_000_000), 'utf8');
    const stored = await this.objects.putBytes(
      `artifacts/tasks/${taskId}/runs/${taskRunId}/console.log`,
      bytes,
      'text/plain; charset=utf-8',
    );
    await this.createRecord(
      taskId,
      taskRunId,
      'CONSOLE_LOG',
      stored,
      'text/plain; charset=utf-8',
    );
  }

  async captureHar(
    taskId: string,
    taskRunId: string,
    path: string,
  ): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      sanitizeHar(parsed);
      const bytes = Buffer.from(JSON.stringify(parsed), 'utf8');
      const stored = await this.objects.putBytes(
        `artifacts/tasks/${taskId}/runs/${taskRunId}/network.har`,
        bytes,
        'application/json',
      );
      await this.createRecord(
        taskId,
        taskRunId,
        'NETWORK_HAR',
        stored,
        'application/json',
      );
    } finally {
      await rm(path, { force: true });
    }
  }

  private async storeFile(
    taskId: string,
    taskRunId: string,
    type: string,
    fileName: string,
    path: string,
    contentType: string,
  ): Promise<void> {
    const stored = await this.objects.putFile(
      `artifacts/tasks/${taskId}/runs/${taskRunId}/${fileName}`,
      path,
      contentType,
    );
    await this.createRecord(taskId, taskRunId, type, stored, contentType);
  }

  private async createRecord(
    taskId: string,
    taskRunId: string,
    type: string,
    stored: { uri: string; sizeBytes: number },
    contentType: string,
  ): Promise<void> {
    await this.prisma.artifact.create({
      data: {
        taskId,
        taskRunId,
        type,
        storageUri: stored.uri,
        contentType,
        sizeBytes: BigInt(stored.sizeBytes),
      },
    });
  }
}

function sanitizeHar(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const object = value as Record<string, unknown>;
  if (typeof object.url === 'string') {
    try {
      const url = new URL(object.url);
      url.search = '';
      url.hash = '';
      object.url = url.toString();
    } catch {
      object.url = '[invalid-url]';
    }
  }
  if (Array.isArray(object.headers)) {
    for (const header of object.headers) {
      if (!header || typeof header !== 'object') continue;
      const item = header as Record<string, unknown>;
      if (
        typeof item.name === 'string' &&
        /^(authorization|cookie|set-cookie|proxy-authorization)$/i.test(item.name)
      ) {
        item.value = '[REDACTED]';
      }
    }
  }
  if ('cookies' in object) object.cookies = [];
  if ('postData' in object) object.postData = { text: '[REDACTED]' };
  for (const child of Object.values(object)) {
    if (Array.isArray(child)) child.forEach(sanitizeHar);
    else sanitizeHar(child);
  }
}
