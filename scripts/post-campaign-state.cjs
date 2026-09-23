const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createRequire } = require('node:module');
process.env.DATABASE_URL = readFileSync('.env', 'utf8').match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
const { PrismaClient } = createRequire(resolve('packages/database/package.json'))('@prisma/client');
const prisma = new PrismaClient();
prisma.facebookCampaign.findMany({ where: { kind: 'POST', ...(process.argv[2] ? { id: process.argv[2] } : {}) }, orderBy: { createdAt: 'desc' }, select: {
  id: true, name: true, payload: true, createdAt: true, approvedAt: true, pausedAt: true, cancelledAt: true,
  tasks: { orderBy: { createdAt: 'asc' }, select: { id: true, status: true, attemptCount: true, workflowId: true, payload: true, lastError: true,
    account: { select: { id: true, username: true, status: true, browserProfile: { select: { id: true, status: true, storageUri: true, snapshotVersion: true } }, proxyBinding: { select: { proxy: { select: { id: true, name: true, status: true } } } } } },
    runs: { orderBy: { startedAt: 'desc' }, take: 1, select: { id: true, errorCode: true, result: true, artifacts: { select: { type: true, storageUri: true } } } },
  } },
} }).then(rows => console.log(JSON.stringify(rows.map(row => ({
  ...row, payload: { intervalSeconds: row.payload.intervalSeconds, textLength: row.payload.text?.length },
  tasks: row.tasks.map(task => ({ ...task, payload: { groupUrl: task.payload.groupUrl },
    account: { ...task.account, browserProfile: task.account.browserProfile && { id: task.account.browserProfile.id, status: task.account.browserProfile.status, snapshotVersion: task.account.browserProfile.snapshotVersion } },
    runs: task.runs.map(run => ({ ...run, artifacts: run.artifacts.filter(a => ['FAILURE_SCREENSHOT', 'PLAYWRIGHT_TRACE'].includes(a.type)) })),
  })),
})), null, 2))).finally(() => prisma.$disconnect());
