import { LitElement, html } from 'lit';

import type { TopologyStoreState } from '../state/topology-store';

export class LatticeHoverCard extends LitElement {
  static properties = {
    state: { attribute: false },
  };

  declare state: TopologyStoreState;

  createRenderRoot(): this {
    return this;
  }

  render() {
    const hoverCard = this.state?.hoverCard ?? null;
    return html`
      <div
        class="hover-card"
        data-role="hover-card"
        ?hidden=${!hoverCard}
        style=${hoverCard ? `left:${hoverCard.x}px;top:${hoverCard.y}px;` : ''}
      >
        <div class="hover-card__title" data-role="hover-title">${hoverCard?.title ?? ''}</div>
        <div class="hover-card__body" data-role="hover-body">${hoverCard?.body ?? ''}</div>
      </div>
    `;
  }
}

customElements.define('lattice-hover-card', LatticeHoverCard);
