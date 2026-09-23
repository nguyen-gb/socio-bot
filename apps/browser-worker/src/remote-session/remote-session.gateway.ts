import { createServer, type Server } from 'node:http';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { remoteBrowserCommandSchema } from '@socio/contracts';
import { verifyRemoteSessionToken } from '@socio/remote-session-auth';
import type { CDPSession, Page } from 'playwright';
import WebSocket, { WebSocketServer } from 'ws';
import Redis from 'ioredis';
import { withDeadline } from '@socio/browser-runtime';
import type { WorkerEnvironment } from '../config/environment';
import { RemoteBrowser } from './remote-browser';

interface RegisteredSession {
  browser: RemoteBrowser;
  clients: Set<WebSocket>;
  latestFrame?: string;
}

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;

@Injectable()
export class RemoteSessionGateway implements OnModuleDestroy {
  private readonly inputQueues = new WeakMap<CDPSession, Promise<void>>();
  private readonly mouseStates = new WeakMap<CDPSession, { x: number; y: number; down: boolean }>();
  private readonly sessions = new Map<string, RegisteredSession>();
  private readonly port: number;
  private readonly secret: string;
  private server?: Server;
  private webSocketServer?: WebSocketServer;
  private readonly redisUrl: string;
  private readonly relayEnabled: boolean;
  private publisher?: Redis;
  private subscriber?: Redis;
  private readonly relayedClients = new Map<string, Set<WebSocket>>();

  constructor(config: ConfigService<WorkerEnvironment, true>) {
    this.port = config.get('remoteSessionPort', { infer: true });
    this.secret = config.get('remoteSessionSecret', { infer: true });
    this.redisUrl = config.get('redisUrl', { infer: true });
    this.relayEnabled = config.get('remoteSessionRedisRelay', { infer: true });
  }

  async start(): Promise<void> {
    if (this.server) return;

    if (this.relayEnabled) {
      this.publisher = new Redis(this.redisUrl, { lazyConnect: true });
      this.subscriber = new Redis(this.redisUrl, { lazyConnect: true });
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      this.subscriber.on('message', (channel, message) => {
        void this.handleRelayMessage(channel, message).catch(() => undefined);
      });
    }

    this.server = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (request.url === '/metrics') {
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(
          `# TYPE socio_worker_remote_sessions gauge\nsocio_worker_remote_sessions ${this.sessions.size.toString()}\n`,
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    this.webSocketServer = new WebSocketServer({ server: this.server });
    this.webSocketServer.on('connection', (socket, request) => {
      void this.acceptConnection(socket, request.url ?? '/');
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.port, '0.0.0.0', () => resolve());
    });
  }

  async register(sessionId: string, page: Page): Promise<void> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Remote session ${sessionId} is already registered`);
    }

    const browser = new RemoteBrowser(page, message => {
      if (message['type'] === 'tabChanging') registered.latestFrame = undefined;
      const encoded = JSON.stringify(message);
      if (message['type'] === 'frame') registered.latestFrame = encoded;
      for (const client of registered.clients) if (client.readyState === WebSocket.OPEN) client.send(encoded);
      void this.publisher?.publish(relayChannel(sessionId, 'output'), encoded);
    }, cdp => this.queueCommand(cdp, '{"type":"release"}'));
    const registered: RegisteredSession = { browser, clients: new Set() };
    this.sessions.set(sessionId, registered);
    await this.subscriber?.subscribe(relayChannel(sessionId, 'input'));
    await browser.start(page);
  }

  getPlatformPage(sessionId: string, home: string): Page | undefined {
    const browser = this.sessions.get(sessionId)?.browser;
    const host = new URL(home).hostname.replace(/^www\./, '');
    const matches = (page: Page | undefined) => { if (!page || page.isClosed()) return false; const name = new URL(page.url()).hostname; return name === host || name.endsWith(`.${host}`); };
    return matches(browser?.activePage) ? browser!.activePage : [...(browser?.pages.values() ?? [])].find(matches);
  }

  async unregister(sessionId: string): Promise<void> {
    const registered = this.sessions.get(sessionId);
    if (registered) {
      this.sessions.delete(sessionId);
      await this.subscriber?.unsubscribe(relayChannel(sessionId, 'input'));
      for (const client of registered.clients) {
        client.close(1000, 'Session closed');
      }
      await registered.browser.dispose();
      await this.publisher?.publish(relayChannel(sessionId, 'output'), JSON.stringify({ type: 'sessionClosed' }));
    }
    for (const client of this.relayedClients.get(sessionId) ?? []) {
      client.close(1000, 'Session closed');
    }
    this.relayedClients.delete(sessionId);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(
      [...new Set([...this.sessions.keys(), ...this.relayedClients.keys()])].map((id) => this.unregister(id)),
    );
    await new Promise<void>((resolve) => {
      if (!this.webSocketServer) return resolve();
      this.webSocketServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    await Promise.allSettled([
      this.subscriber?.quit() ?? Promise.resolve(),
      this.publisher?.quit() ?? Promise.resolve(),
    ]);
  }

  private async acceptConnection(socket: WebSocket, rawUrl: string): Promise<void> {
    const url = new URL(rawUrl, `http://localhost:${this.port.toString()}`);
    const match = /^\/sessions\/([0-9a-f-]+)$/i.exec(url.pathname);
    const sessionId = match?.[1];
    const token = url.searchParams.get('token');
    if (
      !sessionId ||
      !token ||
      !verifyRemoteSessionToken(sessionId, token, this.secret)
    ) {
      socket.close(1008, 'Invalid or expired session token');
      return;
    }

    const registered = this.sessions.get(sessionId);
    if (!registered) {
      await this.attachRelay(socket, sessionId);
      return;
    }

    registered.clients.add(socket);
    socket.send(
      JSON.stringify({
        type: 'ready',
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
      }),
    );
    if (registered.latestFrame) socket.send(registered.latestFrame);
    void this.dispatchSession(registered, '{"type":"browserState"}');
    socket.on('close', () => {
      registered.clients.delete(socket);
      void this.dispatchSession(registered, '{"type":"release"}');
    });
    socket.on('message', (data) => {
      void this.dispatchSession(registered, data.toString());
    });
  }

  private async attachRelay(socket: WebSocket, sessionId: string): Promise<void> {
    if (!this.publisher || !this.subscriber) {
      socket.close(1013, 'Browser session is not ready');
      return;
    }
    const clients = this.relayedClients.get(sessionId) ?? new Set<WebSocket>();
    if (clients.size === 0) {
      await this.subscriber.subscribe(relayChannel(sessionId, 'output'));
    }
    clients.add(socket);
    this.relayedClients.set(sessionId, clients);
    socket.send(
      JSON.stringify({
        type: 'ready',
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
        relayed: true,
      }),
    );
    await this.publisher.publish(relayChannel(sessionId, 'input'), '{"type":"browserState"}');
    socket.on('message', (data) => {
      void this.publisher?.publish(
        relayChannel(sessionId, 'input'),
        data.toString(),
      );
    });
    socket.once('close', () => {
      clients.delete(socket);
      void this.publisher?.publish(relayChannel(sessionId, 'input'), '{"type":"release"}').catch(() => undefined);
      if (clients.size === 0) {
        this.relayedClients.delete(sessionId);
        void this.subscriber?.unsubscribe(relayChannel(sessionId, 'output'));
      }
    });
  }

  private async handleRelayMessage(channel: string, message: string): Promise<void> {
    const parsed = /^socio:remote:([0-9a-f-]+):(input|output)$/i.exec(channel);
    if (!parsed) return;
    const sessionId = parsed[1]!;
    if (parsed[2] === 'input') {
      const local = this.sessions.get(sessionId);
      if (local) await this.dispatchSession(local, message);
      return;
    }
    for (const client of this.relayedClients.get(sessionId) ?? []) {
      if (client.readyState === WebSocket.OPEN) {
        if (JSON.parse(message).type === 'sessionClosed') client.close(1000, 'Session closed');
        else client.send(message);
      }
    }
  }

  private async dispatchSession(registered: RegisteredSession, raw: string) {
    try {
      const payload = JSON.parse(raw);
      const parsed = remoteBrowserCommandSchema.safeParse(payload);
      if (!parsed.success) throw new Error('Lệnh không hợp lệ; địa chỉ phải là HTTP/HTTPS');
      await registered.browser.run(async () => {
        // A click queued for the previous tab must never reach the new tab.
        if (payload.targetTabId && payload.targetTabId !== registered.browser.activeId && parsed.data.type !== 'release') return;
        if (!(await registered.browser.command(parsed.data))) await this.queueCommand(registered.browser.cdp, raw);
        if (parsed.data.type === 'browserState' && registered.latestFrame) {
          for (const client of registered.clients) if (client.readyState === WebSocket.OPEN) client.send(registered.latestFrame);
          const id = [...this.sessions].find(([, value]) => value === registered)?.[0];
          if (id) await this.publisher?.publish(relayChannel(id, 'output'), registered.latestFrame);
        }
      });
    } catch (error) {
      const message = JSON.stringify({ type: 'commandError', message: error instanceof Error ? error.message.split('\n')[0] : 'Thao tác thất bại' });
      for (const client of registered.clients) if (client.readyState === WebSocket.OPEN) client.send(message);
      const id = [...this.sessions].find(([, value]) => value === registered)?.[0];
      if (id) await this.publisher?.publish(relayChannel(id, 'output'), message);
    }
  }

  private queueCommand(cdp: CDPSession, rawMessage: string): Promise<void> {
    // Mouse down/move/up and key pairs must remain ordered even over a relay.
    const next = (this.inputQueues.get(cdp) ?? Promise.resolve())
      .then(() => this.handleCommand(cdp, rawMessage));
    this.inputQueues.set(cdp, next.catch(() => undefined));
    return next;
  }

  private async handleCommand(cdp: CDPSession, rawMessage: string): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(rawMessage);
    } catch {
      return;
    }
    const parsed = remoteBrowserCommandSchema.safeParse(payload);
    if (!parsed.success) return;

    const command = parsed.data;
    const mouse = this.mouseStates.get(cdp) ?? { x: 0, y: 0, down: false };
    this.mouseStates.set(cdp, mouse);
    if (command.type === 'release') {
      if (mouse.down) {
        mouse.down = false;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mouse.x, y: mouse.y, button: 'left', buttons: 0, clickCount: 1 });
      }
      return;
    }
    if (command.type === 'wheel' || command.type === 'mouse') {
      mouse.x = Math.min(VIEWPORT_WIDTH - 1, Math.round(command.x * VIEWPORT_WIDTH));
      mouse.y = Math.min(VIEWPORT_HEIGHT - 1, Math.round(command.y * VIEWPORT_HEIGHT));
      if (command.type === 'wheel') {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mouse.x, y: mouse.y, deltaX: command.deltaX, deltaY: command.deltaY, modifiers: 0 });
      } else {
        if (command.action === 'down') mouse.down = true;
        if (command.action === 'up') mouse.down = false;
        await cdp.send('Input.dispatchMouseEvent', {
          type: command.action === 'down' ? 'mousePressed' : command.action === 'up' ? 'mouseReleased' : 'mouseMoved',
          x: mouse.x, y: mouse.y, button: command.action === 'move' && !mouse.down ? 'none' : 'left',
          buttons: mouse.down ? 1 : 0, clickCount: command.action === 'move' ? 0 : 1,
        });
      }
      return;
    }
    if (command.type === 'click') {
      const x = Math.round(command.x * VIEWPORT_WIDTH);
      const y = Math.round(command.y * VIEWPORT_HEIGHT);
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: command.button,
        clickCount: 1,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: command.button,
        clickCount: 1,
      });
      return;
    }

    if (command.type === 'text') {
      await cdp.send('Input.insertText', { text: command.text });
      return;
    }

    if (command.type !== 'key') return;
    const keyCode = keyCodeFor(command.key);
    const modifiers = command.shift ? 8 : 0;
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: command.key,
      code: command.key,
      windowsVirtualKeyCode: keyCode,
      modifiers,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: command.key,
      code: command.key,
      windowsVirtualKeyCode: keyCode,
      modifiers,
    });
  }
}

function relayChannel(sessionId: string, direction: 'input' | 'output'): string {
  return `socio:remote:${sessionId}:${direction}`;
}

function keyCodeFor(key: string): number {
  return { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key] ?? 0;
}
