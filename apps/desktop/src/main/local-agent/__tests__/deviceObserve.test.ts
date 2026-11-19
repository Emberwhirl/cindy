/**
 * Guards makecindy/cindy#11188 late Agent Island readiness through the real device-observe
 * adapter and loopback wait path. Coverage gap: readiness after the adapter's first subscription.
 * Minimal failure: island absent during subscribe/first read, then starts while a device poll waits.
 * tier: integration (real loopback socket; adapter dependencies are injected module fakes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type FakeIsland = {
  subscribeSessionActivity(listener: () => void): () => void;
  emit(): void;
};

const mocks = vi.hoisted(() => {
  let island: FakeIsland | undefined;
  let rows: unknown[] = [];
  const listeners = new Set<() => void>();
  const readyListeners = new Set<(service: FakeIsland) => void>();
  const list = vi.fn(async () => rows);
  const onReady = (listener: (service: FakeIsland) => void) => {
    if (island) {
      listener(island);
      return () => {};
    }
    readyListeners.add(listener);
    return () => readyListeners.delete(listener);
  };
  const startIsland = () => {
    const service: FakeIsland = {
      subscribeSessionActivity(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit() {
        for (const listener of listeners) listener();
      },
    };
    island = service;
    const pending = [...readyListeners];
    readyListeners.clear();
    for (const listener of pending) listener(service);
    return service;
  };
  return {
    get island() {
      return island;
    },
    set island(value: FakeIsland | undefined) {
      island = value;
    },
    get rows() {
      return rows;
    },
    set rows(value: unknown[]) {
      rows = value;
    },
    listeners,
    readyListeners,
    list,
    onReady,
    startIsland,
  };
});

vi.mock('../../agent-island/service.js', () => ({
  getAgentIslandService: () => mocks.island,
  onAgentIslandServiceReady: (listener: (service: FakeIsland) => void) => mocks.onReady(listener),
}));
vi.mock('../../deepLink.js', () => ({
  openMainWindowSession: vi.fn(),
}));
vi.mock('../../maker-ipc/pluginObserveTasks.js', () => ({
  listDeviceObserveTasks: () => mocks.list(),
}));

import { createLocalAgentServer, type LocalAgentServerDeps } from '../server.js';
import type { LocalAgentModel } from '../catalog.js';
import { desktopDeviceObserve } from '../deviceObserve.js';

const model: LocalAgentModel = {
  id: 'test-model',
  provider: 'custom',
  engine: 'pi',
  model: 'test',
  label: 'Test',
  efforts: [],
  images: false,
  isDefault: true,
};
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  mocks.island = undefined;
  mocks.rows = [];
  mocks.listeners.clear();
  mocks.readyListeners.clear();
  mocks.list.mockClear();
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-device-observe-'));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const deviceObserve = desktopDeviceObserve(() => {});
  const deps: LocalAgentServerDeps = {
    directory,
    version: 'test',
    scope: () => 'owner',
    models: async () => [model],
    approve: async () => true,
    open: async () => ({
      id: 'native',
      resumed: false,
      call: async () => ({}),
      close: async () => {},
    }),
    warn: () => {},
    deviceObserve,
  };
  const server = await createLocalAgentServer(deps);
  cleanup.push(() => server.close());
  let sequence = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}, secret?: string) => {
    const response = await fetch(`${server.base}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({ version: 1, id: `device-observe:${++sequence}`, method, params }),
    });
    const body = (await response.json()) as {
      result?: Record<string, unknown>;
      error?: { code?: string };
    };
    return { status: response.status, body };
  };
  const started = await rpc('connect/start', {
    client: { id: 'org.example.device', name: 'Device' },
  });
  const pair = started.body.result as { id: string; claim: string; url: string };
  await fetch(pair.url);
  const polled = await rpc('connect/poll', { id: pair.id, claim: pair.claim });
  const secret = (polled.body.result as { token: string }).token;
  await server.setObserveLocalTasks(server.connections()[0].id, true);
  return { server, rpc, secret };
}

describe('desktopDeviceObserve late island readiness', () => {
  it('attaches after the island starts and wakes on a subsequent activity emit', async () => {
    const f = await fixture();
    const first = await f.rpc('device/activity', {}, f.secret);
    const cursor = (first.body.result as { cursor: number }).cursor;
    const pending = f.rpc('device/activity', { cursor, waitMs: 2_500 }, f.secret);
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const island = mocks.startIsland();
    mocks.rows = [
      {
        id: 'new-task',
        title: 'New task',
        agentKind: 'codex',
        status: 'running',
        lastActivityAt: 30,
        startedAt: 20,
        turnGeneration: 1,
      },
    ];
    const signaledAt = performance.now();
    island.emit();

    // real-wait: require activity to wake the poll well before its 2.5s timeout.
    const changed = await pending;
    expect(performance.now() - signaledAt).toBeLessThan(1_000);
    expect((changed.body.result as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it('wakes a pending poll on island attachment even without an activity emit', async () => {
    const f = await fixture();
    const first = await f.rpc('device/activity', {}, f.secret);
    const cursor = (first.body.result as { cursor: number }).cursor;
    const pending = f.rpc('device/activity', { cursor, waitMs: 2_500 }, f.secret);
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    mocks.rows = [
      {
        id: 'new-task',
        title: 'New task',
        agentKind: 'codex',
        status: 'running',
        lastActivityAt: 30,
        startedAt: 20,
        turnGeneration: 1,
      },
    ];

    const startedAt = performance.now();
    mocks.startIsland();
    const changed = await pending;

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect((changed.body.result as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it('clears a pending readiness registration when the last listener unsubscribes', () => {
    const observe = desktopDeviceObserve(() => {});
    const unsubscribe = observe.subscribe(vi.fn());
    expect(mocks.readyListeners.size).toBe(1);

    unsubscribe();

    expect(mocks.readyListeners.size).toBe(0);
  });
});
