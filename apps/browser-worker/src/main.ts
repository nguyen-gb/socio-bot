import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NativeConnection, Worker } from '@temporalio/worker';
import { AppModule } from './app.module';
import { BrowserTaskActivities } from './activities/browser-task.activities';
import { LoginSessionActivities } from './activities/login-session.activities';
import { ProxyCheckActivities } from './activities/proxy-check.activities';
import type { WorkerEnvironment } from './config/environment';
import { WorkerRegistryService } from './worker-registry/worker-registry.service';
import { RemoteSessionGateway } from './remote-session/remote-session.gateway';
import { JsonLogger } from './common/json-logger';
import { BrowserControlService } from './runtime/browser-control.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  const config = app.get(ConfigService<WorkerEnvironment, true>);
  app.useLogger(new JsonLogger());
  const registry = app.get(WorkerRegistryService);
  const activities = app.get(BrowserTaskActivities);
  const loginActivities = app.get(LoginSessionActivities);
  const proxyCheckActivities = app.get(ProxyCheckActivities);
  const remoteGateway = app.get(RemoteSessionGateway);

  await registry.start();
  await app.get(BrowserControlService).start();
  await remoteGateway.start();
  const connection = await NativeConnection.connect({
    address: config.get('temporalAddress', { infer: true }),
  });
  const worker = await Worker.create({
    connection,
    namespace: config.get('temporalNamespace', { infer: true }),
    taskQueue: config.get('temporalTaskQueue', { infer: true }),
    maxConcurrentActivityTaskExecutions: config.get('browserSlots', { infer: true }),
    workflowsPath: require.resolve('@socio/temporal-workflows'),
    activities: {
      materializeScheduledTask:
        activities.materializeScheduledTask.bind(activities),
      executeBrowserTask: activities.executeBrowserTask.bind(activities),
      runInteractiveLoginSession:
        loginActivities.runInteractiveLoginSession.bind(loginActivities),
      checkProxyConnectivity:
        proxyCheckActivities.checkProxyConnectivity.bind(proxyCheckActivities),
    },
  });

  const shutdown = async () => {
    worker.shutdown();
    await connection.close();
    await app.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await worker.run();
}

void bootstrap();
