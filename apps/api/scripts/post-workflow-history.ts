import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, Connection } from '@temporalio/client';
async function main() {
  const env = Object.fromEntries(readFileSync(resolve('../../.env'), 'utf8').split(/\r?\n/).filter(s => /^[A-Z_]+=/.test(s)).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1).replace(/^"|"$/g, '')]; }));
  const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS });
  try {
    const client = new Client({ connection, namespace: env.TEMPORAL_NAMESPACE ?? 'default' });
    for (const workflowId of process.argv.slice(2)) {
      const handle = client.workflow.getHandle(workflowId);
      const history = await handle.fetchHistory();
      console.log(JSON.stringify({ workflowId, status: (await handle.describe()).status.name, failures: history.events?.flatMap(event => {
        const failed = event.activityTaskFailedEventAttributes?.failure ?? event.activityTaskTimedOutEventAttributes?.failure ?? event.activityTaskStartedEventAttributes?.lastFailure;
        return failed ? [{ eventId: event.eventId, message: failed.message, cause: failed.cause?.message, timeout: failed.timeoutFailureInfo?.timeoutType }] : [];
      }) }, null, 2));
    }
  } finally { await connection.close(); }
}
void main();
