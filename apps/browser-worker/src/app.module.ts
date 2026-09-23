import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
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
  ],
})
export class AppModule {}
