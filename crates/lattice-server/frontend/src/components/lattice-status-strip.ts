import { LitElement, html } from 'lit';

import type { TopologyStoreState } from '../state/topology-store';

export class LatticeStatusStrip extends LitElement {
  static properties = {
    state: { attribute: false },
  };

  declare state: TopologyStoreState;

  createRenderRoot(): this {
    return this;
  }

  render() {
    if (!this.state) {
      return html``;
    }

    return html`
      <section class="status-strip" aria-live="polite">
        <div class="status-strip__item">
          <span class="status-strip__label">状態</span>
          <span
            class="status-pill"
            data-role="status-pill"
            data-status=${this.state.snapshot.discovery_status.state}
            style=${`background:${this.state.statusTheme.bg};color:${this.state.statusTheme.fg};`}
            >${this.state.statusLabel}</span
          >
        </div>

        <div class="status-strip__item">
          <span class="status-strip__label">更新</span>
          <span
            data-role="status-message"
            data-transport=${this.state.transport.note}
            title=${this.state.transport.note}
            >${this.state.statusMessage}</span
          >
        </div>

        <div class="status-strip__item">
          <span class="status-strip__label">構成</span>
          <span data-role="summary">${this.state.summaryText}</span>
        </div>
      </section>
    `;
  }
}

customElements.define('lattice-status-strip', LatticeStatusStrip);
