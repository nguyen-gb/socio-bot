import type { LoggerService } from '@nestjs/common';
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

export class JsonLogger implements LoggerService {
  private readonly file = logFileStream();
  log(message: unknown, context?: string) { this.write('info', message, context); }
  error(message: unknown, trace?: string, context?: string) {
    this.write('error', message, context, trace);
  }
  warn(message: unknown, context?: string) { this.write('warn', message, context); }
  debug(message: unknown, context?: string) { this.write('debug', message, context); }
  verbose(message: unknown, context?: string) { this.write('trace', message, context); }

  private write(level: string, message: unknown, context?: string, trace?: string) {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: 'socio-api',
      context,
      message: typeof message === 'string' ? message : message,
      trace,
    });
    if (level === 'error') process.stderr.write(`${entry}\n`);
    else process.stdout.write(`${entry}\n`);
    this.file?.write(`${entry}\n`);
  }
}

function logFileStream(): WriteStream | undefined {
  const path = process.env.LOG_FILE;
  if (!path) return undefined;
  mkdirSync(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: 'a' });
}
