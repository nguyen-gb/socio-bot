import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LoginSessionResult,
  LoginSessionWorkflowInput,
} from '@socio/contracts';
import { withDeadline, type BrowserRuntime, type ManagedBrowserSession } from '@socio/browser-runtime';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { WorkerEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { ProfileLeaseService } from '../leases/profile-lease.service';
import { RemoteSessionGateway } from '../remote-session/remote-session.gateway';
import { BROWSER_RUNTIME } from '../runtime/runtime.providers';
import { ProfileSnapshotsService } from '../storage/profile-snapshots.service';
import { WorkerRegistryService } from '../worker-registry/worker-registry.service';
import { SecretsService } from '../secrets/secrets.service';
import { initializePlatformSession, isPlatformAuthenticated, isPlatformChallenged, profileLoginSettings, PLATFORM_LOGIN, type SupportedPlatform } from './platform-login';
export { parseCookieInput } from './platform-login';

@Injectable()
export class LoginSessionActivities {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leases: ProfileLeaseService,
    private readonly registry: WorkerRegistryService,
    private readonly gateway: RemoteSessionGateway,
    private readonly snapshots: ProfileSnapshotsService,
    private readonly secrets: SecretsService,
    private readonly config: ConfigService<WorkerEnvironment, true>,
    @Inject(BROWSER_RUNTIME) private readonly runtime: BrowserRuntime,
  ) {}

  async runInteractiveLoginSession(
    input: LoginSessionWorkflowInput,
  ): Promise<LoginSessionResult> {
    const requestedSession = await this.prisma.browserSession.findUnique({
      where: { id: input.sessionId },
      include: {
        profile: {
          include: {
            account: { include: { proxyBinding: { include: { proxy: true } } } },
          },
        },
      },
    });
    if (!requestedSession || requestedSession.mode !== 'LOGIN') {
      throw ApplicationFailure.nonRetryable(
        'Interactive login session not found',
        'SESSION_NOT_FOUND',
      );
    }

    return this.leases.withLease(requestedSession.profileId, async () => {
      let managed: ManagedBrowserSession | undefined;
      let slotId: string | undefined;
      let completion: LoginSessionResult['status'] | undefined;
      const complete = (status: LoginSessionResult['status']): LoginSessionResult => { completion = status; return { status }; };
      const activityContext = Context.current();
      const heartbeat = setInterval(() => activityContext.heartbeat({ stage: 'interactive_login', sessionId: input.sessionId }), 10_000);
      try {
        const initial = await this.prisma.browserSession.findUnique({ where: { id: requestedSession.id } });
        if (!initial || initial.status === 'CLOSING' || ['CLOSED', 'CRASHED', 'EXPIRED'].includes(initial.status)) return complete('CLOSED');
        const claimed = await this.prisma.browserSession.updateMany({ where: { id: requestedSession.id, status: 'STARTING' }, data: { workerId: this.registry.workerId } });
        if (claimed.count !== 1) return complete('CLOSED');
        Context.current().heartbeat({ stage: 'restoring_profile_snapshot' });
        await this.snapshots.restore(requestedSession.profile);
        Context.current().heartbeat({ stage: 'opening_login_browser' });
        managed = await this.runtime.openProfile({
          profileId: requestedSession.profileId,
          ownerId: requestedSession.id,
          proxy: await toRuntimeProxy(
            requestedSession.profile.account.proxyBinding?.proxy,
            this.secrets,
          ),
          headless: this.config.get('browserHeadless', { infer: true }),
        });
        const loginSettings = profileLoginSettings(
          requestedSession.profile.metadata,
        );
        const credentials = loginSettings.credentialsRef
          ? await this.secrets.profileCredentials(loginSettings.credentialsRef)
          : undefined;
        const platform = requestedSession.profile.account
          .platform as SupportedPlatform;

        const slot = await this.prisma.workerSlot.findUnique({
          where: {
            workerId_slotIndex: {
              workerId: this.registry.workerId,
              slotIndex: managed.slot,
            },
          },
        });
        if (!slot) {
          throw new Error(`Worker slot ${managed.slot.toString()} is not registered`);
        }
        slotId = slot.id;

        const publicUrl = this.config
          .get('remoteSessionPublicUrl', { infer: true })
          .replace(/\/$/, '');
        await this.prisma.$transaction([
          this.prisma.browserSession.updateMany({
            where: { id: requestedSession.id, status: 'STARTING' },
            data: {
              workerId: this.registry.workerId,
              slotId,
              status: 'RUNNING',
              debugEndpoint: `${publicUrl}/sessions/${requestedSession.id}`,
              lastActiveAt: new Date(),
              lastError: null,
              processId: managed.processId,
            },
          }),
          this.prisma.workerSlot.update({
            where: { id: slotId },
            data: { status: 'RUNNING' },
          }),
          this.prisma.browserProfile.update({
            where: { id: requestedSession.profileId },
            data: { status: 'LEASED' },
          }),
        ]);

        const openedState = await this.prisma.browserSession.findUnique({ where: { id: requestedSession.id } });
        if (openedState?.status !== 'RUNNING') return complete('CLOSED');
        await withDeadline(this.gateway.register(requestedSession.id, managed.page), 10_000, 'Remote browser startup timed out');
        await withDeadline(initializePlatformSession(managed, platform, credentials), 150_000, 'Login browser initialization timed out');

        await cancellableDelay(1_500);
        let iteration = 0;
        let reportedStatus = requestedSession.profile.account.status;
        while (true) {
          Context.current().heartbeat({
            stage: 'waiting_for_interactive_login',
            sessionId: requestedSession.id,
          });

          const state = await this.prisma.browserSession.findUnique({
            where: { id: requestedSession.id },
            select: { status: true, expiresAt: true },
          });
          if (!state || state.status === 'CLOSING' || managed.signal?.aborted) return complete('CLOSED');
          // Closing the original tab or browsing another site must not crash the
          // session or falsely mark a logged-in account as LOGIN_REQUIRED.
          const platformPage = this.gateway.getPlatformPage(requestedSession.id, PLATFORM_LOGIN[platform].home);
          let status = reportedStatus;
          if (platformPage) {
            const checking = { ...managed, page: platformPage };
            try {
              const authenticated = await withDeadline(isPlatformAuthenticated(checking, platform), 10_000, 'Browser login check timed out');
              status = authenticated ? 'READY' : await withDeadline(isPlatformChallenged(checking), 5_000, 'Browser challenge check timed out') ? 'CHALLENGED' : 'LOGIN_REQUIRED';
            } catch (error) { if (!platformPage.isClosed()) throw error; }
          }
          if (status !== reportedStatus) {
            await this.prisma.platformAccount.update({
              where: { id: requestedSession.profile.accountId },
              data: { status },
            });
            reportedStatus = status;
          }

          if (state.expiresAt.getTime() <= Date.now()) {
            return complete('EXPIRED');
          }

          iteration += 1;
          if (iteration % 5 === 0) {
            await this.prisma.browserSession.update({
              where: { id: requestedSession.id },
              data: { lastActiveAt: new Date() },
            });
          }
          await cancellableDelay(1_000);
        }
      } catch (error) {
        const state = await this.prisma.browserSession.findUnique({ where: { id: requestedSession.id } });
        if (state?.status === 'CLOSING') return complete('CLOSED');
        if (state && state.expiresAt.getTime() <= Date.now()) return complete('EXPIRED');
        const message = error instanceof Error ? error.message : String(error);
        await this.prisma.$transaction([
          this.prisma.browserSession.update({
            where: { id: requestedSession.id },
            data: { status: 'CRASHED', lastError: message, closedAt: new Date() },
          }),
          this.prisma.platformAccount.update({
            where: { id: requestedSession.profile.accountId },
            data: { status: 'ERROR' },
          }),
        ]);
        throw error;
      } finally {
        try {
          await withDeadline(this.gateway.unregister(requestedSession.id), 5_000, 'Remote browser cleanup timed out').catch(() => undefined);
          try {
            await managed?.close();
            if (managed) {
              Context.current().heartbeat({ stage: 'saving_profile_snapshot' });
              await this.snapshots.capture(requestedSession.profileId);
            } else {
              await this.prisma.browserProfile.update({
                where: { id: requestedSession.profileId },
                data: { status: 'AVAILABLE' },
              });
            }
            if (completion) await this.prisma.browserSession.update({ where: { id: requestedSession.id }, data: { status: completion, closedAt: new Date(), lastActiveAt: new Date() } });
          } catch (snapshotError) {
            const message = snapshotError instanceof Error
              ? snapshotError.message
              : String(snapshotError);
            await this.prisma.$transaction([
              this.prisma.browserSession.update({
                where: { id: requestedSession.id },
                data: { status: 'CRASHED', lastError: `Profile persistence failed: ${message}` },
              }),
              this.prisma.platformAccount.update({
                where: { id: requestedSession.profile.accountId },
                data: { status: 'ERROR' },
              }),
            ]);
            throw snapshotError;
          } finally {
          if (slotId) {
            await this.prisma.workerSlot.update({
              where: { id: slotId },
              data: { status: 'AVAILABLE' },
            });
          }
          }
        } finally {
          clearInterval(heartbeat);
        }
      }
    });
  }

}

async function toRuntimeProxy(
  proxy:
    | {
        protocol: 'HTTP' | 'HTTPS' | 'SOCKS5';
        host: string;
        port: number;
        credentialsRef: string | null;
      }
    | null
    | undefined,
  secrets: SecretsService,
) {
  if (!proxy) return undefined;
  const credentials = proxy.credentialsRef
    ? await secrets.proxyCredentials(proxy.credentialsRef)
    : undefined;
  return {
    server: `${proxy.protocol.toLowerCase()}://${proxy.host}:${proxy.port.toString()}`,
    username: credentials?.username,
    password: credentials?.password,
  };
}

async function cancellableDelay(milliseconds: number): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    Context.current().cancelled,
  ]);
}
