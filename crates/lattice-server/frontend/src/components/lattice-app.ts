import { LitElement, html } from 'lit';

import type { DiscoveryState } from '../model/view-snapshot';
import type { TopologySceneAdapter } from '../scene/topology-scene';
import { TopologyStore, type TopologyStoreState } from '../state/topology-store';
import { preferredEntryForDevice } from '../topology/view-model';
import { TopologyTransport } from '../transport/topology-transport';
import { resolveTreeHoverCardPosition } from './hover-card-position';
import './lattice-hover-card';
import './lattice-sidebar-tree';

declare global {
  interface Window {
    __latticeViewer?: {
      getState: () => TopologyStoreState;
      screenAnchorForDevice: (
        deviceId: string
      ) =>
        | { visibility: 'behind' | 'offscreen' | 'visible'; x: number; y: number }
        | null;
      screenPointForDevice: (deviceId: string) => { x: number; y: number } | null;
      selectDevice: (deviceId: string) => void;
      transport: TopologyTransport;
    };
  }
}

function shouldSyncScene(
  previousState: TopologyStoreState | null,
  nextState: TopologyStoreState
): boolean {
  if (!previousState) {
    return true;
  }

  return (
    previousState.model !== nextState.model ||
    previousState.snapshot !== nextState.snapshot ||
    previousState.selectedDeviceId !== nextState.selectedDeviceId ||
    previousState.hoveredDeviceId !== nextState.hoveredDeviceId ||
    previousState.hoveredLinkId !== nextState.hoveredLinkId
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class LatticeApp extends LitElement {
  static properties = {
    discoveryPending: { attribute: false },
    discoveryPressed: { attribute: false },
    isCompactLayout: { attribute: false },
    nowMs: { attribute: false },
    sidebarOpen: { attribute: false },
    state: { attribute: false },
  };

  declare discoveryPending: boolean;
  declare discoveryPressed: boolean;
  declare isCompactLayout: boolean;
  declare nowMs: number;
  declare sidebarOpen: boolean;
  declare state: TopologyStoreState;

  #store = new TopologyStore();
  #transport = new TopologyTransport(this.#store);
  #scene: TopologySceneAdapter | null = null;
  #sceneLoadPromise: Promise<void> | null = null;
  #unsubscribe: (() => void) | null = null;
  #clockTimer: number | null = null;
  #layoutObserver: ResizeObserver | null = null;
  #mediaQuery: MediaQueryList | null = null;
  #releaseDiscoveryPress = () => {
    this.discoveryPressed = false;
    window.removeEventListener('pointerup', this.#releaseDiscoveryPress);
    window.removeEventListener('pointercancel', this.#releaseDiscoveryPress);
  };
  #handleViewportModeChange = (event: MediaQueryListEvent) => {
    this.#syncViewportMode(event.matches);
  };

  constructor() {
    super();
    this.discoveryPending = false;
    this.discoveryPressed = false;
    this.isCompactLayout = false;
    this.nowMs = Date.now();
    this.sidebarOpen = false;
    this.state = this.#store.getState();
  }

  createRenderRoot(): this {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.#unsubscribe = this.#store.subscribe((nextState) => {
      const previousState = this.state;
      this.state = nextState;
      if (this.#scene && shouldSyncScene(previousState, nextState)) {
        this.#scene.sync(nextState);
      }
    });
    this.#startClock();
    this.#bindViewportMode();
    this.#transport.start();
  }

  disconnectedCallback(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#stopClock();
    this.#unbindViewportMode();
    this.#unbindLayoutObserver();
    this.#transport.stop();
    this.#releaseDiscoveryPress();
    this.#scene?.dispose();
    this.#scene = null;
    this.#sceneLoadPromise = null;
    super.disconnectedCallback();
  }

  firstUpdated(): void {
    const sceneHost = this.querySelector<HTMLElement>('#scene-host');
    if (!sceneHost) {
      throw new Error('Scene host #scene-host was not found.');
    }
    this.#sceneLoadPromise ??= this.#mountScene(sceneHost);
    this.#bindLayoutObserver();

    window.__latticeViewer = {
      getState: () => this.#store.getState(),
      screenAnchorForDevice: (deviceId: string) =>
        this.#scene?.screenAnchorForDevice(deviceId) ?? null,
      screenPointForDevice: (deviceId: string) =>
        this.#scene?.screenPointForDevice(deviceId) ?? null,
      selectDevice: (deviceId: string) => {
        const entryId = preferredEntryForDevice(this.#store.getState().model, deviceId);
        if (entryId) {
          this.#store.selectEntry(entryId, { reveal: true, source: 'scene' });
        }
      },
      transport: this.#transport,
    };
  }

  async #mountScene(sceneHost: HTMLElement): Promise<void> {
    const { TopologySceneAdapter } = await import('../scene/topology-scene');
    if (!this.isConnected || this.#scene) {
      return;
    }

    this.#scene = new TopologySceneAdapter({
      host: sceneHost,
      onClearHover: () => this.#store.clearHover('scene'),
      onHoverTarget: (target, pointer) => {
        if (!target) {
          this.#store.clearHover('scene');
          return;
        }
        if (target.kind === 'device') {
          this.#store.hoverSceneDevice(target.deviceId, pointer);
          return;
        }
        this.#store.hoverSceneLink(target.linkId, pointer);
      },
      onSelectDevice: (deviceId) => {
        const entryId =
          (this.state.selectedDeviceId === deviceId && this.state.selectedEntryId) ||
          preferredEntryForDevice(this.state.model, deviceId);
        if (entryId) {
          this.#store.selectEntry(entryId, { reveal: true, source: 'scene' });
          this.#closeSidebar();
        }
      },
    });
    this.#syncSceneLayout();
    this.#scene.sync(this.state);
  }

  #startClock() {
    if (this.#clockTimer) {
      return;
    }
    this.#clockTimer = window.setInterval(() => {
      this.nowMs = Date.now();
    }, 250);
  }

  #stopClock() {
    if (!this.#clockTimer) {
      return;
    }
    window.clearInterval(this.#clockTimer);
    this.#clockTimer = null;
  }

  #bindViewportMode() {
    if (typeof window === 'undefined') {
      return;
    }

    this.#mediaQuery = window.matchMedia('(max-width: 960px)');
    this.#syncViewportMode(this.#mediaQuery.matches);
    if (typeof this.#mediaQuery.addEventListener === 'function') {
      this.#mediaQuery.addEventListener('change', this.#handleViewportModeChange);
      return;
    }
    this.#mediaQuery.addListener(this.#handleViewportModeChange);
  }

  #unbindViewportMode() {
    if (!this.#mediaQuery) {
      return;
    }
    if (typeof this.#mediaQuery.removeEventListener === 'function') {
      this.#mediaQuery.removeEventListener('change', this.#handleViewportModeChange);
    } else {
      this.#mediaQuery.removeListener(this.#handleViewportModeChange);
    }
    this.#mediaQuery = null;
  }

  #syncViewportMode(isCompactLayout: boolean) {
    this.isCompactLayout = isCompactLayout;
    if (!isCompactLayout) {
      this.sidebarOpen = false;
    }
    this.#syncSceneLayout();
  }

  #toggleSidebar() {
    if (!this.isCompactLayout) {
      return;
    }
    this.sidebarOpen = !this.sidebarOpen;
  }

  #closeSidebar() {
    if (this.isCompactLayout) {
      this.sidebarOpen = false;
    }
  }

  async #requestDiscovery() {
    if (this.discoveryPending) {
      return;
    }

    const discoveryState = this.state.discoveryState;
    if (discoveryState === 'discovering' || discoveryState === 'loading') {
      return;
    }

    this.discoveryPending = true;
    try {
      await this.#transport.requestDiscovery();
    } finally {
      this.discoveryPending = false;
    }
  }

  #effectiveDiscoveryState(): DiscoveryState {
    return this.state.discoveryState;
  }

  #discoveryProgress(): number {
    const discoveryState = this.#effectiveDiscoveryState();
    if (discoveryState === 'discovering' || discoveryState === 'loading') {
      return 1;
    }

    const nextAutoDiscoveryAtMs = this.state.nextAutoDiscoveryAtMs;
    if (!nextAutoDiscoveryAtMs) {
      return 1;
    }

    const intervalMs = Math.max(1_000, this.state.autoDiscoveryIntervalSeconds * 1_000);
    return clamp((nextAutoDiscoveryAtMs - this.nowMs) / intervalMs, 0, 1);
  }

  #discoveryTooltip(): { title: string; body: string } {
    const discoveryState = this.#effectiveDiscoveryState();

    if (discoveryState === 'failed') {
      return {
        title: '再探索',
        body: this.state.discoveryMessage ?? '探索を再実行します。',
      };
    }

    if (discoveryState === 'discovering' || discoveryState === 'loading') {
      return {
        title: '探索中',
        body: '完了すると最新の構成に切り替わります。',
      };
    }

    return {
      title: '今すぐ再探索',
      body: '最新の構成を取得します。',
    };
  }

  #discoveryAriaLabel(): string {
    const discoveryState = this.#effectiveDiscoveryState();
    if (discoveryState === 'failed') {
      return '探索を再実行';
    }
    if (discoveryState === 'discovering' || discoveryState === 'loading') {
      return '探索中';
    }
    return '今すぐ再探索';
  }

  #menuTooltipText(): string {
    return this.sidebarOpen ? '構成を閉じる' : '構成を開く';
  }

  #renderMenuIcon() {
    return html`
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M5 7.5h14M5 12h14M5 16.5h14"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-width="1.9"
        ></path>
      </svg>
    `;
  }

  #renderDiscoveryIcon() {
    return html`
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M18.5 8.5A7.5 7.5 0 1 0 20 13.1"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-width="1.9"
        ></path>
        <path
          d="M15.8 5.2h4.4v4.4"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.9"
        ></path>
      </svg>
    `;
  }

  #renderDeviceStatIcon() {
    return html`
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="7" cy="12" r="2.5"></circle>
        <circle cx="17" cy="7" r="2.5"></circle>
        <circle cx="17" cy="17" r="2.5"></circle>
        <path
          d="M9.1 10.9l5.1-2.8M9.1 13.1l5.1 2.8"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-width="1.7"
        ></path>
      </svg>
    `;
  }

  #renderLinkStatIcon() {
    return html`
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M8 8.5h5.5M10.5 15.5H16M5.5 12h13"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-width="1.8"
        ></path>
        <circle cx="6" cy="8.5" r="1.9"></circle>
        <circle cx="18" cy="15.5" r="1.9"></circle>
      </svg>
    `;
  }

  #bindLayoutObserver() {
    const viewport = this.querySelector<HTMLElement>('.viewport');
    const sidebar = this.querySelector<HTMLElement>('[data-role="sidebar-overlay"]');
    if (!viewport || !sidebar || typeof ResizeObserver === 'undefined') {
      this.#syncSceneLayout();
      return;
    }

    this.#layoutObserver?.disconnect();
    this.#layoutObserver = new ResizeObserver(() => this.#syncSceneLayout());
    this.#layoutObserver.observe(viewport);
    this.#layoutObserver.observe(sidebar);
    this.#syncSceneLayout();
  }

  #unbindLayoutObserver() {
    this.#layoutObserver?.disconnect();
    this.#layoutObserver = null;
  }

  #syncSceneLayout() {
    if (!this.#scene) {
      return;
    }

    const viewport = this.querySelector<HTMLElement>('.viewport');
    const sidebar = this.querySelector<HTMLElement>('[data-role="sidebar-overlay"]');
    if (!viewport || !sidebar || this.isCompactLayout) {
      this.#scene.setDesktopLeftInset(0);
      return;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const leftInset = Math.max(0, sidebarRect.right - viewportRect.left);
    this.#scene.setDesktopLeftInset(leftInset);
  }

  #handleDiscoveryPointerDown = (event: PointerEvent) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      return;
    }

    this.discoveryPressed = true;
    window.addEventListener('pointerup', this.#releaseDiscoveryPress, { once: true });
    window.addEventListener('pointercancel', this.#releaseDiscoveryPress, { once: true });
  };

  #handleDiscoveryKeyDown = (event: KeyboardEvent) => {
    if (event.key !== ' ' && event.key !== 'Enter') {
      return;
    }

    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      return;
    }

    this.discoveryPressed = true;
  };

  #handleDiscoveryKeyUp = (event: KeyboardEvent) => {
    if (event.key !== ' ' && event.key !== 'Enter') {
      return;
    }

    this.discoveryPressed = false;
  };

  #treeHoverCardBounds():
    | { bottom: number; left: number; right: number; top: number }
    | null {
    const viewport = this.querySelector<HTMLElement>('.viewport');
    const sidebar = this.querySelector<HTMLElement>('[data-role="sidebar-overlay"]');
    if (!viewport) {
      return null;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const leftInset =
      !sidebar || this.isCompactLayout
        ? 0
        : Math.max(0, sidebar.getBoundingClientRect().right - viewportRect.left);

    return {
      left: leftInset,
      top: 0,
      right: viewportRect.width,
      bottom: viewportRect.height,
    };
  }

  #resolvedHoverCardPosition():
    | { x: number; y: number }
    | null
    | undefined {
    if (!this.state.hoverCard) {
      return undefined;
    }

    if (this.state.hoverSource !== 'tree' || !this.state.hoveredDeviceId) {
      return undefined;
    }

    const anchor = this.#scene?.screenAnchorForDevice(this.state.hoveredDeviceId) ?? null;
    const bounds = this.#treeHoverCardBounds();
    if (!anchor || !bounds) {
      return null;
    }

    return resolveTreeHoverCardPosition(anchor, bounds);
  }

  render() {
    const discoveryState = this.#effectiveDiscoveryState();
    const discoveryTooltip = this.#discoveryTooltip();
    const discoveryControlDisabled =
      this.discoveryPending || discoveryState === 'discovering' || discoveryState === 'loading';

    return html`
      <main id="app">
        <section
          class=${[
            'viewport',
            this.state.viewportReady ? 'is-ready' : '',
            this.sidebarOpen ? 'is-sidebar-open' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <div
            class="viewport__scene"
            id="scene-host"
            aria-label="3D network topology view"
          ></div>

          <div class="viewport__toolbar viewport__toolbar--start">
            <div class="floating-action floating-action--start">
              <button
                type="button"
                class="icon-button icon-button--menu"
                data-role="sidebar-toggle"
                aria-label=${this.#menuTooltipText()}
                @click=${() => this.#toggleSidebar()}
              >
                ${this.#renderMenuIcon()}
              </button>
              <div class="floating-tooltip" data-role="sidebar-tooltip">
                <p class="floating-tooltip__title">${this.#menuTooltipText()}</p>
                <p class="floating-tooltip__body">構成ツリーを表示します。</p>
              </div>
            </div>
          </div>

          <div class="viewport__toolbar viewport__toolbar--end">
            <div
              class="floating-action floating-action--end"
              data-role="discovery-action"
            >
              <div
                class="discovery-control"
                data-role="discovery-control"
                data-discovery-state=${discoveryState}
                style=${`--ring-progress:${this.#discoveryProgress().toFixed(4)};`}
              >
                <span class="discovery-control__ring" aria-hidden="true"></span>
                <button
                  type="button"
                  class="icon-button icon-button--discovery"
                  data-pressed=${this.discoveryPressed ? 'true' : 'false'}
                  aria-label=${this.#discoveryAriaLabel()}
                  ?disabled=${discoveryControlDisabled}
                  @blur=${this.#releaseDiscoveryPress}
                  @click=${() => {
                    void this.#requestDiscovery();
                  }}
                  @keydown=${this.#handleDiscoveryKeyDown}
                  @keyup=${this.#handleDiscoveryKeyUp}
                  @pointerdown=${this.#handleDiscoveryPointerDown}
                >
                  <span class="icon-button__glyph">${this.#renderDiscoveryIcon()}</span>
                </button>
              </div>
              <div class="floating-tooltip" data-role="discovery-tooltip">
                <p class="floating-tooltip__title">${discoveryTooltip.title}</p>
                <p class="floating-tooltip__body">${discoveryTooltip.body}</p>
              </div>
            </div>
          </div>

          <button
            type="button"
            class="viewport__backdrop"
            ?hidden=${!this.sidebarOpen || !this.isCompactLayout}
            aria-label="構成を閉じる"
            @click=${() => this.#closeSidebar()}
          ></button>

          <aside class="viewport__sidebar-shell" data-role="sidebar-overlay">
            <div class="sidebar-shell__summary">
              <div class="sidebar-shell__brand" aria-hidden="true">L</div>

              <div class="sidebar-shell__stats">
                <div class="floating-action floating-action--end sidebar-stat-action">
                  <div
                    class="sidebar-stat"
                    data-role="device-stat"
                    aria-label=${`${this.state.deviceCount} devices`}
                  >
                    <span class="sidebar-stat__icon">${this.#renderDeviceStatIcon()}</span>
                    <span class="sidebar-stat__value">${this.state.deviceCount}</span>
                  </div>
                  <div class="floating-tooltip" data-role="device-stat-tooltip">
                    <p class="floating-tooltip__title">表示中の機器数</p>
                    <p class="floating-tooltip__body">
                      3Dシーンと構成ツリーに含まれる機器の数です。
                    </p>
                  </div>
                </div>

                <div class="floating-action floating-action--end sidebar-stat-action">
                  <div
                    class="sidebar-stat"
                    data-role="link-stat"
                    aria-label=${`${this.state.visibleLinkCount} links`}
                  >
                    <span class="sidebar-stat__icon">${this.#renderLinkStatIcon()}</span>
                    <span class="sidebar-stat__value">${this.state.visibleLinkCount}</span>
                  </div>
                  <div class="floating-tooltip" data-role="link-stat-tooltip">
                    <p class="floating-tooltip__title">表示中のリンク数</p>
                    <p class="floating-tooltip__body">現在表示している接続の数です。</p>
                  </div>
                </div>
              </div>
            </div>

            <lattice-sidebar-tree
              .state=${this.state}
              @entry-hover=${(event: CustomEvent<{ entryId: string }>) =>
                this.#store.hoverEntry(event.detail.entryId)}
              @entry-primary-action=${(event: CustomEvent<{ entryId: string }>) => {
                this.#store.activateEntry(event.detail.entryId, {
                  source: 'tree',
                });
                this.#closeSidebar();
              }}
              @entry-toggle=${(event: CustomEvent<{ entryId: string }>) =>
                this.#store.toggleCollapse(event.detail.entryId)}
              @tree-leave=${() => this.#store.clearHover('tree')}
            ></lattice-sidebar-tree>
          </aside>

          <div class="viewport__empty" data-role="empty-state">
            ${this.state.emptyState
              ? html`
                  <div class="empty-card">
                    <p class="empty-card__title">${this.state.emptyState.title}</p>
                    <p class="empty-card__body">${this.state.emptyState.body}</p>
                  </div>
                `
              : html``}
          </div>

          <lattice-hover-card
            .position=${this.#resolvedHoverCardPosition()}
            .state=${this.state}
          ></lattice-hover-card>
        </section>
      </main>
    `;
  }
}

customElements.define('lattice-app', LatticeApp);
