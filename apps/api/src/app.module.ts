import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AccountsModule } from './accounts/accounts.module';
import { AuditInterceptor } from './audit/audit.interceptor';
import { AuthModule } from './auth/auth.module';
import { RolesGuard } from './auth/roles.guard';
import { ControlApiKeyGuard } from './common/control-api-key.guard';
import { loadEnvironment } from './config/environment';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { ProxiesModule } from './proxies/proxies.module';
import { LoginSessionsModule } from './sessions/login-sessions.module';
import { MediaModule } from './media/media.module';
import { ObjectStorageModule } from './storage/object-storage.module';
import { MetricsModule } from './metrics/metrics.module';
import { OperationsModule } from './operations/operations.module';
import { TasksModule } from './tasks/tasks.module';
import { TemporalModule } from './temporal/temporal.module';
import { SchedulesModule } from './schedules/schedules.module';
import { CredentialsModule } from './credentials/credentials.module';
import { FacebookModule } from './facebook/facebook.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [loadEnvironment],
      cache: true,
    }),
    DatabaseModule,
    CredentialsModule,
    AuthModule,
    ObjectStorageModule,
    TemporalModule,
    HealthModule,
    AccountsModule,
    ProxiesModule,
    LoginSessionsModule,
    MediaModule,
    MetricsModule,
    OperationsModule,
    TasksModule,
    SchedulesModule,
    FacebookModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ControlApiKeyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
  ],
})
export class AppModule {}
