import { LitElement, html } from 'lit';

import type { TopologyStoreState } from '../state/topology-store';

export class LatticeHoverCard extends LitElement {
  static properties = {
    position: { attribute: false },
    state: { attribute: false },
  };

  declare position: { x: number; y: number } | null | undefined;
  declare state: TopologyStoreState;

  constructor() {
    super();
    this.position = undefined;
  }

  createRenderRoot(): this {
    return this;
  }

  render() {
    const baseHoverCard = this.state?.hoverCard ?? null;
    const hoverCard =
      !baseHoverCard
        ? null
        : this.position === undefined
          ? baseHoverCard
          : this.position
            ? {
                ...baseHoverCard,
                x: this.position.x,
                y: this.position.y,
              }
            : null;
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
