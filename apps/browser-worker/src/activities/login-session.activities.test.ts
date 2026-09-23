import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@temporalio/activity';
import { LoginSessionActivities, parseCookieInput } from './login-session.activities';
import { initializePlatformSession, isPlatformAuthenticated } from './platform-login';

test('cookie header is scoped to the selected platform URL', () => {
  const cookies = parseCookieInput(
    'sessionid=abc123; csrftoken=def456',
    'https://www.instagram.com/',
  );
  assert.deepEqual(cookies, [
    {
      name: 'sessionid',
      value: 'abc123',
      url: 'https://www.instagram.com/',
    },
    {
      name: 'csrftoken',
      value: 'def456',
      url: 'https://www.instagram.com/',
    },
  ]);
});

function sessionFixture(initialCookies: Array<{ name: string; value: string }> = [], initialView = 'login') {
  let cookies = [...initialCookies];
  let view = initialView;
  let url = 'https://www.facebook.com/';
  const events: string[] = [];
  const locator = (selector: string): any => ({
    first: () => locator(selector),
    isVisible: async () => selector.includes('captcha') ? view === 'challenge' : selector.includes('navigation') ? view === 'authenticated' : selector.includes('password') || selector.includes('email') || selector.includes('pass') ? view === 'login' : false,
    waitFor: async () => {},
    fill: async () => { events.push('fill-login'); },
    click: async () => { events.push('password-login'); cookies = [{ name: 'c_user', value: 'password-session' }]; view = 'authenticated'; url = 'https://www.facebook.com/'; },
  });
  const session = {
    profileId: 'profile', slot: 0,
    context: {
      cookies: async () => cookies,
      addCookies: async (incoming: any[]) => { events.push('import-cookies'); for (const cookie of incoming) { cookies = cookies.filter(c => c.name !== cookie.name); cookies.push(cookie); } },
    },
    page: {
      url: () => url,
      locator,
      goto: async (target: string) => { events.push('navigate'); url = target; if (view !== 'challenge') view = cookies.some(c => c.name === 'c_user' && c.value && c.value !== 'expired') ? 'authenticated' : 'login'; },
      waitForTimeout: async () => {},
    },
    close: async () => { events.push('close'); },
  };
  return { session: session as never, events, setView: (next: string) => { view = next; }, logout: () => { cookies = []; view = 'login'; } };
}

test('an imported c_user is not READY on a login form or unloaded page', async () => {
  const fixture = sessionFixture([{ name: 'c_user', value: 'expired' }]);
  assert.equal(await isPlatformAuthenticated(fixture.session, 'FACEBOOK'), false);
  fixture.setView('loading');
  assert.equal(await isPlatformAuthenticated(fixture.session, 'FACEBOOK'), false);
  fixture.setView('authenticated');
  assert.equal(await isPlatformAuthenticated(fixture.session, 'FACEBOOK'), true);
});

test('legacy missing session cookies are seeded before browser navigation', async () => {
  const fixture = sessionFixture();
  await initializePlatformSession(fixture.session, 'FACEBOOK', { cookies: 'c_user=valid; xs=valid' });
  assert.equal(await isPlatformAuthenticated(fixture.session, 'FACEBOOK'), true);
  assert.deepEqual(fixture.events, ['import-cookies', 'navigate']);
});

test('a valid restored browser session is not overwritten by stale saved cookies', async () => {
  const fixture = sessionFixture([{ name: 'c_user', value: 'fresh-session' }]);
  await initializePlatformSession(fixture.session, 'FACEBOOK', { cookies: 'c_user=expired' });
  assert.equal(await isPlatformAuthenticated(fixture.session, 'FACEBOOK'), true);
  assert.deepEqual(fixture.events, ['navigate']);
});

test('an expired restored session can fall back to newly supplied cookies', async () => {
  const fixture = sessionFixture([{ name: 'c_user', value: 'expired' }]);
  await initializePlatformSession(fixture.session, 'FACEBOOK', { cookies: 'c_user=valid' });
  assert.equal(await isPlatformAuthenticated(fixture.session, 'FACEBOOK'), true);
  assert.deepEqual(fixture.events, ['navigate', 'import-cookies', 'navigate']);
});

test('invalid cookie input falls back to password, or remains open for manual login', async () => {
  const password = sessionFixture();
  await initializePlatformSession(password.session, 'FACEBOOK', { cookies: 'not-a-cookie', login: 'fixture', password: 'fixture-only' });
  assert.equal(await isPlatformAuthenticated(password.session, 'FACEBOOK'), true);
  assert.equal(password.events.includes('password-login'), true);
  const manual = sessionFixture();
  await initializePlatformSession(manual.session, 'FACEBOOK', { cookies: 'not-a-cookie' });
  assert.equal(await isPlatformAuthenticated(manual.session, 'FACEBOOK'), false);
  assert.equal(manual.events.includes('password-login'), false);
  assert.equal(manual.events.includes('close'), false);
});

test('CAPTCHA does not trigger password submission or claim READY', async () => {
  const fixture = sessionFixture([{ name: 'c_user', value: 'valid' }], 'challenge');
  await initializePlatformSession(fixture.session, 'FACEBOOK', { login: 'fixture', password: 'fixture-only' });
  assert.equal(await isPlatformAuthenticated(fixture.session, 'FACEBOOK'), false);
  assert.equal(fixture.events.includes('password-login'), false);
});

test('interactive login revalidates READY and preserves it when platform tabs are closed', async () => {
  const original = Context.current;
  Context.current = () => ({ heartbeat: () => {}, cancelled: new Promise(() => {}) }) as unknown as Context;
  try {
    for (const loggedIn of [false, true, 'closed-platform-tab']) {
      const fixture = sessionFixture(loggedIn ? [{ name: 'c_user', value: 'valid' }] : []);
      const statuses: string[] = [];
      let reads = 0;
      let captured = false;
      const prisma = {
        browserSession: {
          findUnique: async () => {
            reads++;
            if (reads > 1) return { status: reads >= 5 ? 'CLOSING' : reads === 2 ? 'STARTING' : 'RUNNING', expiresAt: new Date(Date.now() + 60000) };
            return { id: 'session', mode: 'LOGIN', profileId: 'profile', profile: { id: 'profile', accountId: 'account', metadata: {}, account: { status: 'READY', platform: 'FACEBOOK' } } };
          },
          update: async () => ({}),
          updateMany: async () => ({ count: 1 }),
        },
        platformAccount: { update: async (input: any) => { statuses.push(input.data.status); } },
        browserProfile: { update: async () => ({}) },
        workerSlot: { findUnique: async () => ({ id: 'slot' }), update: async () => ({}) },
        $transaction: async (operations: any[]) => Promise.all(operations),
      };
      const service = new LoginSessionActivities(
        prisma as never,
        { withLease: async (_: string, run: any) => run() } as never,
        { workerId: 'worker' } as never,
        { register: async () => {}, unregister: async () => {}, getPlatformPage: () => loggedIn === 'closed-platform-tab' ? undefined : (fixture.session as any).page } as never,
        { restore: async () => {}, capture: async () => { captured = true; } } as never,
        {} as never,
        { get: (name: string) => name === 'remoteSessionPublicUrl' ? 'ws://localhost:3010' : true } as never,
        { openProfile: async () => fixture.session } as never,
      );
      const result = await service.runInteractiveLoginSession({ sessionId: 'session' });
      assert.equal(result.status, 'CLOSED');
      assert.deepEqual(statuses, loggedIn ? [] : ['LOGIN_REQUIRED']);
      assert.equal(captured, true);
      assert.equal(fixture.events.includes('close'), true);
    }
  } finally { Context.current = original; }
});

test('cookie JSON rejects domains outside the selected platform', () => {
  assert.throws(() =>
    parseCookieInput(
      JSON.stringify([{ name: 'sessionid', value: 'abc', domain: '.example.com' }]),
      'https://www.instagram.com/',
    ),
  );
});
