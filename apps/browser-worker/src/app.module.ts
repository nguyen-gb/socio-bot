import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolve } from 'node:path';
import { BrowserTaskActivities } from './activities/browser-task.activities';
import { LoginSessionActivities } from './activities/login-session.activities';
import { ProxyCheckActivities } from './activities/proxy-check.activities';
import { loadEnvironment } from './config/environment';
import { PrismaService } from './database/prisma.service';
import { ProfileLeaseService } from './leases/profile-lease.service';
import { RemoteSessionGateway } from './remote-session/remote-session.gateway';
import { browserRuntimeProvider } from './runtime/runtime.providers';
import { profileSnapshotStoreProvider } from './storage/profile-snapshot.providers';
import { ProfileSnapshotsService } from './storage/profile-snapshots.service';
import { objectStorageProvider } from './storage/object-storage.providers';
import { TaskArtifactsService } from './storage/task-artifacts.service';
import { SecretsService } from './secrets/secrets.service';
import { WorkerRegistryService } from './worker-registry/worker-registry.service';
import { BrowserControlService } from './runtime/browser-control.service';
import { AntiCaptchaService } from './captcha/anticaptcha.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // The worker is commonly started from apps/browser-worker, while the
      // local configuration lives at the workspace root. Load both layouts
      // so BROWSER_HEADLESS/BROWSER_CHANNEL are not silently ignored.
      envFilePath: [
        resolve(process.cwd(), '.env'),
        resolve(process.cwd(), '../../.env'),
        resolve(__dirname, '../../../.env'),
      ],
      load: [loadEnvironment],
      cache: true,
    }),
  ],
  providers: [
    PrismaService,
    ProfileLeaseService,
    WorkerRegistryService,
    BrowserControlService,
    BrowserTaskActivities,
    LoginSessionActivities,
    ProxyCheckActivities,
    RemoteSessionGateway,
    browserRuntimeProvider,
    objectStorageProvider,
    profileSnapshotStoreProvider,
    ProfileSnapshotsService,
    TaskArtifactsService,
    SecretsService,
    AntiCaptchaService,
  ],
})
export class AppModule {}
