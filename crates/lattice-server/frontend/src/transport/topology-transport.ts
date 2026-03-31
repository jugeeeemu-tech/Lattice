import { decodeViewSnapshot } from '../topology/decode-view-snapshot';
import type { TopologyStore } from '../state/topology-store';

type DiscoveryRequestResponse =
  | { snapshot: unknown; status: 'started' }
  | { status: 'busy' };

export class TopologyTransport {
  #store: TopologyStore;
  #fetchInFlight = false;
  #pollTimer: number | null = null;
  #reconnectTimer: number | null = null;
  #ws: WebSocket | null = null;
  #wsReconnectDelay = 1000;

  constructor(store: TopologyStore) {
    this.#store = store;
  }

  start(): void {
    this.#store.setTransport('idle', '初期化中');
    void this.refreshSnapshot({ quiet: true, source: 'http' });
    this.connectWebSocket();
    this.startPolling();
  }

  stop(): void {
    if (this.#pollTimer) {
      window.clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (this.#reconnectTimer) {
      window.clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        // Ignore stale close failures during cleanup.
      }
      this.#ws = null;
    }
  }

  async refreshSnapshot(
    options: { quiet?: boolean; source?: 'http' | 'polling' } = {}
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
      this.#store.applySnapshot(
        decodeViewSnapshot(payload),
        options.source === 'polling' ? 'polling' : 'http'
      );
      return true;
    } catch (error) {
      if (!options.quiet) {
        const message = error instanceof Error ? error.message : String(error);
        this.#store.applyFailureState(`HTTP snapshot fetch failed: ${message}`);
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
      this.#store.applyFailureState(`Discovery request failed: ${message}`);
    }
  }

  connectWebSocket(force = false): void {
    if (typeof WebSocket === 'undefined') {
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
      try {
        this.#ws.close();
      } catch {
        // Ignore stale socket close failures.
      }
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/topology`);
    this.#ws = socket;

    socket.addEventListener('open', () => {
      this.#wsReconnectDelay = 1000;
      this.stopPolling();
      this.#store.setTransport('websocket', 'WebSocket connected');
    });

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data as string);
        this.#store.applySnapshot(decodeViewSnapshot(payload), 'ws');
      } catch {
        // Keep the last stable snapshot on malformed frames.
      }
    });

    socket.addEventListener('close', () => {
      if (this.#ws === socket) {
        this.#ws = null;
      }
      this.#store.setTransport('polling', 'WebSocket reconnecting');
      this.startPolling();
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      this.#store.setTransport(
        this.#ws?.readyState === WebSocket.OPEN ? 'websocket' : 'polling',
        'WebSocket error'
      );
    });
  }

  startPolling(): void {
    if (this.#pollTimer || (this.#ws && this.#ws.readyState === WebSocket.OPEN)) {
      return;
    }

    const tick = async () => {
      this.#pollTimer = null;

      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        return;
      }

      await this.refreshSnapshot({ quiet: true, source: 'polling' });

      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
        this.#pollTimer = window.setTimeout(tick, 1800);
      }
    };

    this.#store.setTransport('polling', 'Polling fallback active');
    this.#pollTimer = window.setTimeout(tick, 300);
  }

  stopPolling(): void {
    if (this.#pollTimer) {
      window.clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
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
}
