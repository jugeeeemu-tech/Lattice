import { decodeViewSnapshot } from '../topology/decode-view-snapshot';
import type { TopologyStore } from '../state/topology-store';

type DiscoveryRequestResponse =
  | { snapshot: unknown; status: 'started' }
  | { status: 'busy' };

export class TopologyTransport {
  #store: TopologyStore;
  #fetchInFlight = false;
  #reconnectTimer: number | null = null;
  #ws: WebSocket | null = null;
  #wsReconnectDelay = 1000;
  #stopped = false;

  constructor(store: TopologyStore) {
    this.#store = store;
  }

  start(): void {
    this.#stopped = false;
    this.#store.setTransport('connecting', 'スナップショットを読み込んでいます');
    void this.refreshSnapshot({
      reportTransportFailure: true,
      transportFailureNote: '初回のスナップショット取得に失敗しました',
    });
    this.connectWebSocket();
  }

  stop(): void {
    this.#stopped = true;
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
    if (this.#fetchInFlight) {
      return false;
    }

    this.#fetchInFlight = true;

    try {
      const response = await fetch('/api/topology', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      this.#store.applySnapshot(decodeViewSnapshot(payload), 'http');
      return true;
    } catch (error) {
      if (options.reportTransportFailure) {
        const message = error instanceof Error ? error.message : String(error);
        this.#store.setTransport(
          this.#transportModeForConnectionState(),
          `${options.transportFailureNote ?? 'HTTPでのスナップショット取得に失敗しました'}: ${message}`
        );
      }
      return false;
    } finally {
      this.#fetchInFlight = false;
    }
  }

  async requestDiscovery(): Promise<void> {
    try {
      const response = await fetch('/api/discover', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as DiscoveryRequestResponse;
      if (payload.status === 'started') {
        this.#store.applySnapshot(decodeViewSnapshot(payload.snapshot), 'http');
        this.connectWebSocket(true);
      }
    } catch (error) {
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
      if (this.#ws.readyState < WebSocket.CLOSING) {
        this.#ws.close();
      }
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/topology`);
    this.#ws = socket;
    this.#store.setTransport('connecting', 'ライブ更新へ接続しています');

    socket.addEventListener('open', () => {
      if (this.#reconnectTimer) {
        window.clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = null;
      }
      this.#wsReconnectDelay = 1000;
      this.#store.setTransport('websocket', 'ライブ更新に接続しました');
    });

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data as string);
        this.#store.applySnapshot(decodeViewSnapshot(payload), 'ws');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#handleSocketFailure(socket, `ライブ更新の受信内容を解釈できません: ${message}`);
      }
    });

    socket.addEventListener('close', () => {
      if (this.#ws === socket) {
        this.#ws = null;
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
}
