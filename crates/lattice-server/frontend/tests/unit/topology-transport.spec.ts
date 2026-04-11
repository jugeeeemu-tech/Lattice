import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TopologyStore } from '../../src/state/topology-store';
import { TopologyTransport } from '../../src/transport/topology-transport';
import { loadViewSnapshotFixture } from '../helpers/load-view-snapshot-fixture';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send() {}

  close() {
    if (this.readyState >= MockWebSocket.CLOSING) {
      return;
    }

    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close'));
  }

  open() {
    if (this.readyState !== MockWebSocket.CONNECTING) {
      return;
    }

    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  deliverJson(payload: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify(payload),
      })
    );
  }

  emitError() {
    this.dispatchEvent(new Event('error'));
  }
}

describe('TopologyTransport', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('window', {
      clearTimeout,
      location: {
        host: '127.0.0.1:4173',
        protocol: 'http:',
      },
      setTimeout,
    });
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the active websocket during manual discovery so completion updates arrive on the same connection', async () => {
    const store = new TopologyStore();
    const transport = new TopologyTransport(store);
    const baseSnapshot = await loadViewSnapshotFixture('populated');
    const discoveringSnapshot = {
      ...baseSnapshot,
      discovery_status: {
        state: 'discovering' as const,
      },
    };
    const readySnapshot = {
      ...baseSnapshot,
      discovery_status: {
        state: 'ready' as const,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        snapshot: discoveringSnapshot,
        status: 'started' as const,
      }),
      ok: true,
    } as Response);

    vi.stubGlobal('fetch', fetchMock);

    transport.connectWebSocket();
    expect(MockWebSocket.instances).toHaveLength(1);

    const socket = MockWebSocket.instances[0];
    socket?.open();
    expect(store.getState().transport.mode).toBe('websocket');

    await transport.requestDiscovery();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(store.getState().discoveryState).toBe('discovering');

    socket?.deliverJson(readySnapshot);

    expect(store.getState().discoveryState).toBe('ready');
    expect(store.getState().transport.note).toBe('ライブ更新を反映しました');
  });

  it('ignores stale socket close events after a forced reconnect replaces the active connection', () => {
    vi.useFakeTimers();

    const store = new TopologyStore();
    const transport = new TopologyTransport(store);
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({}),
      ok: true,
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    transport.connectWebSocket();
    expect(MockWebSocket.instances).toHaveLength(1);
    const firstSocket = MockWebSocket.instances[0];
    firstSocket?.open();
    expect(store.getState().transport.mode).toBe('websocket');

    transport.connectWebSocket(true);
    expect(MockWebSocket.instances).toHaveLength(2);

    const secondSocket = MockWebSocket.instances[1];
    secondSocket?.open();

    expect(store.getState().transport.mode).toBe('websocket');
    expect(store.getState().transport.note).toBe('ライブ更新に接続しました');

    vi.advanceTimersByTime(1_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(store.getState().transport.mode).toBe('websocket');
    expect(store.getState().transport.note).toBe('ライブ更新に接続しました');

    vi.useRealTimers();
  });

  it('ignores stale socket messages after a forced reconnect creates a new active connection', async () => {
    const store = new TopologyStore();
    const transport = new TopologyTransport(store);
    const baseSnapshot = await loadViewSnapshotFixture('populated');
    const staleSnapshot = {
      ...baseSnapshot,
      discovery_status: {
        state: 'failed' as const,
        message: 'stale socket should not win',
      },
    };
    const activeSnapshot = {
      ...baseSnapshot,
      discovery_status: {
        state: 'ready' as const,
      },
    };

    transport.connectWebSocket();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket?.open();

    transport.connectWebSocket(true);
    const secondSocket = MockWebSocket.instances[1];
    secondSocket?.open();
    secondSocket?.deliverJson(activeSnapshot);

    expect(store.getState().discoveryState).toBe('ready');

    firstSocket?.deliverJson(staleSnapshot);

    expect(store.getState().discoveryState).toBe('ready');
    expect(store.getState().discoveryMessage).toBeNull();
  });

  it('ignores stale socket open events after a forced reconnect creates a new active connection', () => {
    const store = new TopologyStore();
    const transport = new TopologyTransport(store);

    transport.connectWebSocket();
    const firstSocket = MockWebSocket.instances[0];

    transport.connectWebSocket(true);
    const secondSocket = MockWebSocket.instances[1];
    secondSocket?.open();

    expect(store.getState().transport.mode).toBe('websocket');
    expect(store.getState().transport.note).toBe('ライブ更新に接続しました');

    firstSocket?.open();

    expect(store.getState().transport.mode).toBe('websocket');
    expect(store.getState().transport.note).toBe('ライブ更新に接続しました');
  });

  it('ignores stale socket error events after a forced reconnect creates a new active connection', () => {
    const store = new TopologyStore();
    const transport = new TopologyTransport(store);

    transport.connectWebSocket();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket?.open();

    transport.connectWebSocket(true);
    const secondSocket = MockWebSocket.instances[1];
    secondSocket?.open();

    expect(store.getState().transport.mode).toBe('websocket');
    expect(store.getState().transport.note).toBe('ライブ更新に接続しました');

    firstSocket?.emitError();

    expect(store.getState().transport.mode).toBe('websocket');
    expect(store.getState().transport.note).toBe('ライブ更新に接続しました');
  });

  it('does not let a stale reconnect HTTP snapshot overwrite a newer websocket snapshot', async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;

    const store = new TopologyStore();
    const transport = new TopologyTransport(store);
    const baseSnapshot = await loadViewSnapshotFixture('populated');
    const staleHttpSnapshot = {
      ...baseSnapshot,
      discovery_status: {
        state: 'failed' as const,
        message: 'stale reconnect snapshot',
      },
    };
    const liveSnapshot = {
      ...baseSnapshot,
      discovery_status: {
        state: 'ready' as const,
      },
    };
    const fetchDeferred = createDeferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(fetchDeferred.promise);

    vi.stubGlobal('fetch', fetchMock);

    transport.connectWebSocket();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket?.open();

    firstSocket?.close();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(MockWebSocket.instances).toHaveLength(2);

    const secondSocket = MockWebSocket.instances[1];
    secondSocket?.open();
    secondSocket?.deliverJson(liveSnapshot);

    expect(store.getState().discoveryState).toBe('ready');
    expect(store.getState().transport.note).toBe('ライブ更新を反映しました');

    fetchDeferred.resolve({
      json: async () => staleHttpSnapshot,
      ok: true,
    } as Response);
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().discoveryState).toBe('ready');
    expect(store.getState().discoveryMessage).toBeNull();
    expect(store.getState().transport.note).toBe('ライブ更新を反映しました');

    vi.useRealTimers();
  });

  it('does not let a stale reconnect HTTP failure override a recovered websocket state', async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;

    const store = new TopologyStore();
    const transport = new TopologyTransport(store);
    const baseSnapshot = await loadViewSnapshotFixture('populated');
    const liveSnapshot = {
      ...baseSnapshot,
      discovery_status: {
        state: 'ready' as const,
      },
    };
    const fetchDeferred = createDeferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(fetchDeferred.promise);

    vi.stubGlobal('fetch', fetchMock);

    transport.connectWebSocket();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket?.open();

    firstSocket?.close();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(MockWebSocket.instances).toHaveLength(2);

    const secondSocket = MockWebSocket.instances[1];
    secondSocket?.open();
    secondSocket?.deliverJson(liveSnapshot);

    expect(store.getState().transport.mode).toBe('websocket');
    expect(store.getState().transport.note).toBe('ライブ更新を反映しました');

    fetchDeferred.reject(new Error('stale reconnect failure'));
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().transport.mode).toBe('websocket');
    expect(store.getState().transport.note).toBe('ライブ更新を反映しました');

    vi.useRealTimers();
  });

  it('ignores an in-flight HTTP snapshot result after the transport has been stopped', async () => {
    const store = new TopologyStore();
    const transport = new TopologyTransport(store);
    const baseSnapshot = await loadViewSnapshotFixture('populated');
    const fetchDeferred = createDeferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(fetchDeferred.promise);

    vi.stubGlobal('fetch', fetchMock);

    const refreshPromise = transport.refreshSnapshot();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    transport.stop();

    fetchDeferred.resolve({
      json: async () => baseSnapshot,
      ok: true,
    } as Response);

    await refreshPromise;

    expect(store.getState().snapshot).not.toEqual(baseSnapshot);
    expect(store.getState().discoveryState).toBe('loading');
    expect(store.getState().transport.note).toBe('初期化中');
  });

  it('does not let a stale manual discovery response overwrite a newer websocket snapshot', async () => {
    const store = new TopologyStore();
    const transport = new TopologyTransport(store);
    const baseSnapshot = await loadViewSnapshotFixture('populated');
    const liveSnapshot = {
      ...baseSnapshot,
      discovery_status: {
        state: 'ready' as const,
      },
    };
    const staleDiscoverySnapshot = {
      ...baseSnapshot,
      discovery_status: {
        state: 'discovering' as const,
      },
    };
    const fetchDeferred = createDeferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(fetchDeferred.promise);

    vi.stubGlobal('fetch', fetchMock);

    transport.connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket?.open();

    const requestPromise = transport.requestDiscovery();
    socket?.deliverJson(liveSnapshot);

    fetchDeferred.resolve({
      json: async () => ({
        snapshot: staleDiscoverySnapshot,
        status: 'started' as const,
      }),
      ok: true,
    } as Response);

    await requestPromise;

    expect(store.getState().discoveryState).toBe('ready');
    expect(store.getState().transport.note).toBe('ライブ更新を反映しました');
  });

  it('does not let a stale manual discovery failure override a newer websocket snapshot', async () => {
    const store = new TopologyStore();
    const transport = new TopologyTransport(store);
    const baseSnapshot = await loadViewSnapshotFixture('populated');
    const liveSnapshot = {
      ...baseSnapshot,
      discovery_status: {
        state: 'ready' as const,
      },
    };
    const fetchDeferred = createDeferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(fetchDeferred.promise);

    vi.stubGlobal('fetch', fetchMock);

    transport.connectWebSocket();
    const socket = MockWebSocket.instances[0];
    socket?.open();

    const requestPromise = transport.requestDiscovery();
    socket?.deliverJson(liveSnapshot);

    fetchDeferred.reject(new Error('stale discovery failure'));
    await requestPromise;

    expect(store.getState().discoveryState).toBe('ready');
    expect(store.getState().transport.note).toBe('ライブ更新を反映しました');
  });

  it('starts a fresh HTTP snapshot request after stop and restart even if an older request is still in flight', async () => {
    const store = new TopologyStore();
    const transport = new TopologyTransport(store);
    const firstFetch = createDeferred<Response>();
    const secondFetch = createDeferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(firstFetch.promise)
      .mockReturnValueOnce(secondFetch.promise);

    vi.stubGlobal('fetch', fetchMock);

    transport.start();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    transport.stop();
    transport.start();

    expect(fetchMock).toHaveBeenCalledTimes(2);

    firstFetch.resolve({
      json: async () => ({}),
      ok: true,
    } as Response);
    secondFetch.resolve({
      json: async () => ({
        ...((await loadViewSnapshotFixture('populated')) as object),
      }),
      ok: true,
    } as Response);

    await Promise.resolve();
    await Promise.resolve();
  });

  it('does not let a stale topology refresh overwrite a newer manual discovery snapshot', async () => {
    const store = new TopologyStore();
    const transport = new TopologyTransport(store);
    const baseSnapshot = await loadViewSnapshotFixture('populated');
    const staleTopologySnapshot = {
      ...baseSnapshot,
      discovery_status: {
        state: 'ready' as const,
      },
    };
    const manualDiscoverySnapshot = {
      ...baseSnapshot,
      discovery_status: {
        state: 'discovering' as const,
      },
    };
    const topologyFetch = createDeferred<Response>();
    const discoverFetch = createDeferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(topologyFetch.promise)
      .mockReturnValueOnce(discoverFetch.promise);

    vi.stubGlobal('fetch', fetchMock);

    const refreshPromise = transport.refreshSnapshot();
    const discoveryPromise = transport.requestDiscovery();

    discoverFetch.resolve({
      json: async () => ({
        snapshot: manualDiscoverySnapshot,
        status: 'started' as const,
      }),
      ok: true,
    } as Response);
    await discoveryPromise;

    expect(store.getState().discoveryState).toBe('discovering');

    topologyFetch.resolve({
      json: async () => staleTopologySnapshot,
      ok: true,
    } as Response);
    await refreshPromise;

    expect(store.getState().discoveryState).toBe('discovering');
  });
});
