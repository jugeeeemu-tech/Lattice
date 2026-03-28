import { LitElement, html, type TemplateResult } from 'lit';

import type { TopologyStoreState } from '../state/topology-store';
import { entryMetaText } from '../topology/view-model';

export class LatticeSidebarTree extends LitElement {
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
      <div
        class="tree"
        role="tree"
        aria-label="scene navigation"
        @pointerleave=${this.#handlePointerLeave}
      >
        ${this.state.model.treeRootEntryIds.length > 0
          ? this.state.model.treeRootEntryIds.map((entryId) => this.#renderEntry(entryId, 0))
          : html`<div class="tree__empty">表示できる構成を待っています。</div>`}
      </div>
    `;
  }

  #renderEntry(entryId: string, depth: number): TemplateResult {
    const entry = this.state.model.sidebarEntryById.get(entryId);
    const device = entry ? this.state.model.deviceById.get(entry.device_id) : null;
    if (!entry || !device) {
      return html``;
    }

    const childIds = this.state.model.sidebarChildrenById.get(entry.id) ?? [];
    const hasChildren = childIds.length > 0;
    const expanded = !this.state.collapsedEntryIds.has(entry.id);
    const isSelected = entry.id === this.state.selectedEntryId;
    const isHovered =
      entry.id === this.state.hoveredEntryId ||
      this.state.hoveredPathEntryIds.has(entry.id) ||
      (this.state.hoverSource === 'scene' && this.state.hoveredEntryPeers.has(entry.id));
    const isAncestor = this.state.selectedPathEntryIds.has(entry.id) && !isSelected;
    const isPeer = this.state.selectedEntryPeers.has(entry.id) && !isSelected;

    return html`
      <div
        class=${[
          'tree-row',
          isSelected ? 'is-selected' : '',
          isHovered ? 'is-hovered' : '',
          isAncestor ? 'is-ancestor' : '',
          isPeer ? 'is-peer' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-device-id=${entry.device_id}
        data-entry-id=${entry.id}
        role="treeitem"
        aria-expanded=${hasChildren ? String(expanded) : 'false'}
        style=${`padding-inline-start:${0.4 + depth * 1.05}rem;`}
      >
        <button
          type="button"
          class=${`tree-toggle ${hasChildren && expanded ? 'is-open' : ''} ${
            hasChildren ? '' : 'tree-toggle--leaf'
          }`}
          aria-label=${hasChildren ? (expanded ? '折りたたむ' : '展開する') : 'leaf'}
          ?disabled=${!hasChildren}
          @click=${() => this.#dispatch('entry-toggle', { entryId: entry.id })}
        ></button>

        <button
          type="button"
          class="tree-row__label"
          @click=${() => this.#dispatch('entry-primary-action', { entryId: entry.id })}
          @pointerover=${() => this.#dispatch('entry-hover', { entryId: entry.id })}
        >
          <span
            class="tree-row__mark"
            data-role-kind=${device.device_role}
            data-deployment=${device.deployment_type}
          ></span>
          <span class="tree-row__copy">
            <span class="tree-row__name">${entry.label || device.label || 'Unknown'}</span>
            <span class="tree-row__meta">${entryMetaText(this.state.model, entry)}</span>
          </span>
        </button>
      </div>

      ${hasChildren && expanded
        ? childIds.map((childEntryId) => this.#renderEntry(childEntryId, depth + 1))
        : html``}
    `;
  }

  #dispatch(name: string, detail: Record<string, string>) {
    this.dispatchEvent(
      new CustomEvent(name, {
        bubbles: true,
        composed: true,
        detail,
      })
    );
  }

  #handlePointerLeave() {
    this.dispatchEvent(
      new CustomEvent('tree-leave', {
        bubbles: true,
        composed: true,
      })
    );
  }
}

customElements.define('lattice-sidebar-tree', LatticeSidebarTree);
