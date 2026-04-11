import { decodeViewSnapshot } from '../topology/decode-view-snapshot';
import type { TopologyStore } from '../state/topology-store';

type DiscoveryRequestResponse =
  | { snapshot: unknown; status: 'started' }
  | { status: 'busy' }
  | { retry_after_seconds: number; status: 'rate_limited' };

export class TopologyTransport {
  #store: TopologyStore;
  #activeRefreshToken: symbol | null = null;
  #appliedSnapshotVersion = 0;
  #lifecycleVersion = 0;
  #reconnectTimer: number | null = null;
  #ws: WebSocket | null = null;
  #wsReconnectDelay = 1000;
  #stopped = false;

  constructor(store: TopologyStore) {
    this.#store = store;
  }

  start(): void {
    this.#stopped = false;
    this.#lifecycleVersion += 1;
    this.#store.setTransport('connecting', 'スナップショットを読み込んでいます');
    void this.refreshSnapshot({
      reportTransportFailure: true,
      transportFailureNote: '初回のスナップショット取得に失敗しました',
    });
    this.connectWebSocket();
  }

  stop(): void {
    this.#stopped = true;
    this.#lifecycleVersion += 1;
    this.#activeRefreshToken = null;
    if (this.#reconnectTimer) {
      window.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#ws) {
      if (this.#ws.readyState < WebSocket.CLOSING) {
        this.#ws.close();
      }
      this.#ws = null;
    }
  }

  async refreshSnapshot(
    options: {
      reportTransportFailure?: boolean;
      transportFailureNote?: string;
    } = {}
  ): Promise<boolean> {
    if (this.#activeRefreshToken) {
      return false;
    }

    const refreshToken = Symbol('refresh');
    this.#activeRefreshToken = refreshToken;
    const lifecycleVersionAtStart = this.#lifecycleVersion;
    const snapshotVersionAtStart = this.#appliedSnapshotVersion;

    try {
      const response = await fetch('/api/topology', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (!this.#isLifecycleCurrent(lifecycleVersionAtStart)) {
        return false;
      }

      if (this.#appliedSnapshotVersion !== snapshotVersionAtStart) {
        return false;
      }

      this.#applySnapshot(decodeViewSnapshot(payload), 'http');
      return true;
    } catch (error) {
      if (!this.#isLifecycleCurrent(lifecycleVersionAtStart)) {
        return false;
      }

      if (this.#appliedSnapshotVersion !== snapshotVersionAtStart) {
        return false;
      }

      if (options.reportTransportFailure) {
        const message = error instanceof Error ? error.message : String(error);
        this.#store.setTransport(
          this.#transportModeForConnectionState(),
          `${options.transportFailureNote ?? 'HTTPでのスナップショット取得に失敗しました'}: ${message}`
        );
      }
      return false;
    } finally {
      if (this.#activeRefreshToken === refreshToken) {
        this.#activeRefreshToken = null;
      }
    }
  }

  async requestDiscovery(): Promise<void> {
    const lifecycleVersionAtStart = this.#lifecycleVersion;
    const snapshotVersionAtStart = this.#appliedSnapshotVersion;

    try {
      const response = await fetch('/api/discover', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      if (!this.#isLifecycleCurrent(lifecycleVersionAtStart)) {
        return;
      }

      const payload = (await response.json()) as DiscoveryRequestResponse;
      if (!this.#isLifecycleCurrent(lifecycleVersionAtStart)) {
        return;
      }

      if (this.#appliedSnapshotVersion !== snapshotVersionAtStart) {
        return;
      }

      if (!response.ok) {
        if (payload.status === 'rate_limited') {
          this.#store.setTransport(
            this.#transportModeForConnectionState(),
            `探索は短時間に繰り返せません。あと ${payload.retry_after_seconds} 秒ほど待ってください`
          );
          return;
        }

        throw new Error(`HTTP ${response.status}`);
      }

      if (payload.status === 'started') {
        this.#applySnapshot(decodeViewSnapshot(payload.snapshot), 'http');
        this.connectWebSocket();
        return;
      }

      if (payload.status === 'busy') {
        this.#store.setTransport(
          this.#transportModeForConnectionState(),
          '別の探索が進行中です。完了後に再度お試しください'
        );
      }
    } catch (error) {
      if (!this.#isLifecycleCurrent(lifecycleVersionAtStart)) {
        return;
      }

      if (this.#appliedSnapshotVersion !== snapshotVersionAtStart) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.#store.setTransport(
        this.#transportModeForConnectionState(),
        `探索の開始に失敗しました: ${message}`
      );
    }
  }

  connectWebSocket(force = false): void {
    if (typeof WebSocket === 'undefined') {
      this.#store.setTransport('connecting', 'ライブ更新を使えません');
      return;
    }

    if (
      this.#ws &&
      !force &&
      (this.#ws.readyState === WebSocket.OPEN ||
        this.#ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    if (force && this.#ws) {
      const previousSocket = this.#ws;
      this.#ws = null;
      if (previousSocket.readyState < WebSocket.CLOSING) {
        previousSocket.close();
      }
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/topology`);
    this.#ws = socket;
    this.#store.setTransport('connecting', 'ライブ更新へ接続しています');

    socket.addEventListener('open', () => {
      if (this.#ws !== socket) {
        return;
      }

      if (this.#reconnectTimer) {
        window.clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = null;
      }
      this.#wsReconnectDelay = 1000;
      this.#store.setTransport('websocket', 'ライブ更新に接続しました');
    });

    socket.addEventListener('message', (event) => {
      if (this.#ws !== socket) {
        return;
      }

      try {
        const payload = JSON.parse(event.data as string);
        this.#applySnapshot(decodeViewSnapshot(payload), 'ws');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#handleSocketFailure(socket, `ライブ更新の受信内容を解釈できません: ${message}`);
      }
    });

    socket.addEventListener('close', () => {
      const isActiveSocket = this.#ws === socket;
      if (isActiveSocket) {
        this.#ws = null;
      }

      if (!isActiveSocket) {
        return;
      }

      if (this.#stopped) {
        return;
      }

      this.#store.setTransport('connecting', 'ライブ更新へ再接続しています');
      void this.refreshSnapshot({
        reportTransportFailure: true,
        transportFailureNote: '再接続中のスナップショット取得に失敗しました',
      });
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (this.#ws !== socket) {
        return;
      }

      this.#store.setTransport(
        this.#ws?.readyState === WebSocket.OPEN ? 'websocket' : 'connecting',
        'ライブ更新で通信エラーが発生しました'
      );
    });
  }

  scheduleReconnect(): void {
    if (this.#reconnectTimer) {
      return;
    }

    this.#reconnectTimer = window.setTimeout(() => {
      this.#reconnectTimer = null;
      this.connectWebSocket();
      this.#wsReconnectDelay = Math.min(this.#wsReconnectDelay * 1.6, 8000);
    }, this.#wsReconnectDelay);
  }

  #handleSocketFailure(socket: WebSocket, note: string): void {
    this.#store.setTransport('connecting', note);

    if (this.#ws !== socket || socket.readyState >= WebSocket.CLOSING) {
      return;
    }

    socket.close();
  }

  #transportModeForConnectionState(): 'connecting' | 'websocket' {
    if (typeof WebSocket === 'undefined') {
      return 'connecting';
    }

    return this.#ws?.readyState === WebSocket.OPEN ? 'websocket' : 'connecting';
  }

  #applySnapshot(snapshot: ReturnType<typeof decodeViewSnapshot>, source: 'http' | 'ws'): void {
    this.#appliedSnapshotVersion += 1;
    this.#store.applySnapshot(snapshot, source);
  }

  #isLifecycleCurrent(version: number): boolean {
    return !this.#stopped && this.#lifecycleVersion === version;
  }
}
