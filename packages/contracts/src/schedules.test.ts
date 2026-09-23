import assert from 'node:assert/strict';
import test from 'node:test';
import { createScheduleSchema } from './schedules';

const accountId = '00000000-0000-4000-8000-000000000002';

test('schedule schema applies bounded defaults and validates timezone', () => {
  const parsed = createScheduleSchema.parse({
    name: 'Hourly health check',
    cronExpression: '0 * * * *',
    action: {
      platform: 'FACEBOOK',
      accountId,
      action: 'HEALTH_CHECK',
      payload: {},
    },
  });
  assert.equal(parsed.timezone, 'UTC');
  assert.equal(parsed.maxAttempts, 3);
  assert.equal(parsed.enabled, true);
  assert.equal(
    createScheduleSchema.safeParse({ ...parsed, timezone: 'Not/A_Timezone' }).success,
    false,
  );
});
