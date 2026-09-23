const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const env = readFileSync('.env', 'utf8');
process.env.DATABASE_URL = env.match(/^DATABASE_URL=(.*)$/m)?.[1].trim().replace(/^"|"$/g, '');
const { PrismaClient } = createRequire(require('node:path').resolve('packages/database/package.json'))('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  console.log(JSON.stringify({
    activeRuns: await prisma.taskRun.count({ where: { status: 'RUNNING' } }),
    activeTasks: await prisma.task.count({ where: { status: 'RUNNING' } }),
    activeBrowsers: await prisma.browserSession.count({ where: { status: { in: ['STARTING', 'RUNNING', 'IDLE', 'CLOSING'] } } }),
    browserSessions: await prisma.browserSession.findMany({ where: { status: { in: ['STARTING', 'RUNNING', 'IDLE', 'CLOSING'] } }, select: { id: true, profileId: true, status: true, mode: true, processId: true, forceCloseRequestedAt: true, startedAt: true, expiresAt: true, worker: { select: { id: true, name: true, status: true, lastHeartbeat: true } } } }),
    campaigns: await prisma.facebookCampaign.findMany({ select: { id: true, name: true, pausedAt: true, cancelledAt: true, tasks: { select: { id: true, status: true, attemptCount: true, lastError: true, account: { select: { username: true, status: true } }, runs: { orderBy: { startedAt: 'desc' }, take: 1, select: { errorCode: true, result: true } } } } } }),
  }, null, 2));
})().finally(() => prisma.$disconnect());
