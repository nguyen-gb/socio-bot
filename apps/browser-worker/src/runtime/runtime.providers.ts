import { ConfigService } from '@nestjs/config';
import { BrowserRuntime } from '@socio/browser-runtime';
import { parseProfileEncryptionKey } from '@socio/object-storage';
import type { WorkerEnvironment } from '../config/environment';

export const BROWSER_RUNTIME = Symbol('BROWSER_RUNTIME');

export const browserRuntimeProvider = {
  provide: BROWSER_RUNTIME,
  inject: [ConfigService],
  // Session-cookie state uses the same key as encrypted profile snapshots.
  useFactory: (config: ConfigService<WorkerEnvironment, true>) =>
    new BrowserRuntime(
      config.get('profileRoot', { infer: true }),
      config.get('browserSlots', { infer: true }),
      parseProfileEncryptionKey(config.get('profileEncryptionKey', { infer: true })),
    ),
};
