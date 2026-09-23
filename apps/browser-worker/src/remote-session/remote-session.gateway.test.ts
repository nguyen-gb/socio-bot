import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { signRemoteSessionToken } from '@socio/remote-session-auth';
import { RemoteSessionGateway } from './remote-session.gateway';

test('remote input preserves drag order, bounds edge coordinates and safely releases a held button', async () => {
  const gateway = new RemoteSessionGateway(relayConfig(39128) as never);
  const calls: Array<{ method: string; params: any }> = [];
  const cdp = { send: async (method: string, params: any) => { await new Promise(resolve => setTimeout(resolve, 2)); calls.push({ method, params }); } };
  const queue = (command: object) => (gateway as any).queueCommand(cdp, JSON.stringify(command));
  await Promise.all([
    queue({ type: 'mouse', action: 'down', x: 1, y: 1 }),
    queue({ type: 'mouse', action: 'move', x: 0.5, y: 0.5 }),
    queue({ type: 'release' }),
    queue({ type: 'release' }),
    queue({ type: 'wheel', x: 0.25, y: 0.5, deltaX: 20, deltaY: -120 }),
    queue({ type: 'key', key: 'PageDown' }),
    queue({ type: 'mouse', action: 'move', x: -1, y: 0 }),
  ]);
  assert.deepEqual(calls.map(call => call.params.type), ['mousePressed', 'mouseMoved', 'mouseReleased', 'mouseWheel', 'rawKeyDown', 'keyUp']);
  assert.deepEqual(calls.slice(0, 3).map(call => call.params.buttons), [1, 1, 0]);
  assert.equal(calls[0]!.params.x, 1279); assert.equal(calls[0]!.params.y, 719);
  assert.equal(calls[3]!.params.x, 320); assert.equal(calls[3]!.params.deltaY, -120);
  assert.equal(calls[4]!.params.windowsVirtualKeyCode, 34);
});

test('remote session gateway exposes health and rejects unsigned sockets', async () => {
  const port = 39123;
  const config = {
    get(key: string) {
      if (key === 'remoteSessionPort') return port;
      if (key === 'remoteSessionSecret') return 'remote-session-test-secret-at-least-32-characters';
      if (key === 'redisUrl') return 'redis://127.0.0.1:1';
      if (key === 'remoteSessionRedisRelay') return false;
      throw new Error(`Unexpected config key ${key}`);
    },
  };
  const gateway = new RemoteSessionGateway(config as never);
  await gateway.start();
  try {
    const health = await fetch(`http://127.0.0.1:${port.toString()}/health`);
    assert.equal(health.status, 200);

    const closeCode = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port.toString()}/sessions/00000000-0000-4000-8000-000000000001`,
      );
      socket.once('close', resolve);
      socket.once('error', reject);
    });
    assert.equal(closeCode, 1008);
  } finally {
    await gateway.onModuleDestroy();
  }
});

test('remote session relay moves commands and frames across worker gateways', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000099';
  const owner = new RemoteSessionGateway(relayConfig(39124) as never);
  const edge = new RemoteSessionGateway(relayConfig(39125) as never);
  const handlers = new Map<string, (event: never) => void>();
  let commandResolve!: () => void;
  const commandReceived = new Promise<void>((resolve) => {
    commandResolve = resolve;
  });
  let reverseTabResolve!: () => void;
  const reverseTabReceived = new Promise<void>((resolve) => {
    reverseTabResolve = resolve;
  });
  const cdp = {
    on(event: string, handler: (event: never) => void) {
      handlers.set(event, handler);
    },
    async send(method: string, params?: { text?: string; key?: string; modifiers?: number }) {
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [] };
      if (method === 'Input.insertText' && params?.text === 'relay-test') {
        commandResolve();
      }
      if (
        method === 'Input.dispatchKeyEvent' &&
        params?.key === 'Tab' &&
        params.modifiers === 8
      ) {
        reverseTabResolve();
      }
      return {};
    },
    async detach() {},
  };
  const page = { context: () => ({ newCDPSession: async () => cdp, pages: () => [page], on: () => {}, off: () => {} }), on: () => {}, off: () => {}, url: () => 'about:blank', title: async () => 'Fixture', isClosed: () => false, setViewportSize: async () => {}, bringToFront: async () => {} };
  await owner.start();
  await edge.start();
  await owner.register(sessionId, page as never);
  const signed = signRemoteSessionToken(
    sessionId,
    'remote-session-test-secret-at-least-32-characters',
    60,
  );
  const socket = new WebSocket(
    `ws://127.0.0.1:39125/sessions/${sessionId}?token=${signed.token}`,
  );
  try {
    const frameReceived = new Promise<void>((resolve) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as { type?: string };
        if (message.type === 'ready') {
          socket.send(JSON.stringify({ type: 'text', text: 'relay-test' }));
          socket.send(JSON.stringify({ type: 'key', key: 'Tab', shift: true }));
          setTimeout(() => {
            handlers.get('Page.screencastFrame')?.({
              sessionId: 1,
              data: 'frame-data',
            } as never);
          }, 25);
        }
        if (message.type === 'frame') resolve();
      });
    });
    await Promise.all([commandReceived, reverseTabReceived, frameReceived]);
  } finally {
    socket.close();
    await owner.unregister(sessionId);
    await Promise.all([owner.onModuleDestroy(), edge.onModuleDestroy()]);
  }
});

function relayConfig(port: number) {
  return {
    get(key: string) {
      if (key === 'remoteSessionPort') return port;
      if (key === 'remoteSessionSecret') {
        return 'remote-session-test-secret-at-least-32-characters';
      }
      if (key === 'redisUrl') return 'redis://127.0.0.1:6379';
      if (key === 'remoteSessionRedisRelay') return true;
      throw new Error(`Unexpected config key ${key}`);
    },
  };
}
