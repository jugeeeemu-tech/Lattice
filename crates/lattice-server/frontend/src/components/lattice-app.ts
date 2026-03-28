import { LitElement, html } from 'lit';

import type { TopologySceneAdapter } from '../scene/topology-scene';
import { TopologyStore, type TopologyStoreState } from '../state/topology-store';
import { preferredEntryForDevice } from '../topology/view-model';
import { TopologyTransport } from '../transport/topology-transport';
import './lattice-hover-card';
import './lattice-sidebar-tree';
import './lattice-status-strip';

declare global {
  interface Window {
    __latticeViewer?: {
      getState: () => TopologyStoreState;
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

export class LatticeApp extends LitElement {
  static properties = {
    state: { attribute: false },
  };

  declare state: TopologyStoreState;

  #store = new TopologyStore();
  #transport = new TopologyTransport(this.#store);
  #scene: TopologySceneAdapter | null = null;
  #sceneLoadPromise: Promise<void> | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor() {
    super();
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
    this.#transport.start();
  }

  disconnectedCallback(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#transport.stop();
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

    window.__latticeViewer = {
      getState: () => this.#store.getState(),
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
        }
      },
    });
    this.#scene.sync(this.state);
  }

  render() {
    return html`
      <main id="app">
        <header class="chrome">
          <div class="chrome__brand">
            <div class="brand-mark" aria-hidden="true">L</div>
            <div>
              <p class="eyebrow">Network topology viewer</p>
              <h1>Lattice</h1>
            </div>
          </div>

          <div class="chrome__actions">
            <button
              type="button"
              class="action action--primary"
              data-action="discover"
              ?disabled=${this.state.discoverButtonDisabled}
              @click=${() => {
                void this.#transport.requestDiscovery();
              }}
            >
              ${this.state.discoverButtonLabel}
            </button>

            <button
              type="button"
              class="action"
              data-action="reload"
              @click=${() => this.#transport.reloadPage()}
            >
              再読込
            </button>
          </div>
        </header>

        <lattice-status-strip .state=${this.state}></lattice-status-strip>

        <div class="workspace">
          <aside class="sidebar">
            <section class="panel panel--info">
              <div class="panel__header">
                <h2>構成</h2>
              </div>

              <lattice-sidebar-tree
                .state=${this.state}
                @entry-hover=${(event: CustomEvent<{ entryId: string }>) =>
                  this.#store.hoverEntry(event.detail.entryId)}
                @entry-select=${(event: CustomEvent<{ entryId: string }>) =>
                  this.#store.selectEntry(event.detail.entryId, {
                    reveal: true,
                    source: 'tree',
                  })}
                @entry-toggle=${(event: CustomEvent<{ entryId: string }>) =>
                  this.#store.toggleCollapse(event.detail.entryId)}
                @tree-leave=${() => this.#store.clearHover('tree')}
              ></lattice-sidebar-tree>
            </section>
          </aside>

          <section class=${`viewport ${this.state.viewportReady ? 'is-ready' : ''}`}>
            <div
              class="viewport__scene"
              id="scene-host"
              aria-label="3D network topology view"
            ></div>
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
            <lattice-hover-card .state=${this.state}></lattice-hover-card>
          </section>
        </div>
      </main>
    `;
  }
}

customElements.define('lattice-app', LatticeApp);
