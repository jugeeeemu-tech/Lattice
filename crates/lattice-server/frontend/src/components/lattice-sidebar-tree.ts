import { LitElement, html, svg, type TemplateResult } from 'lit';

import type { ViewDevice } from '../model/view-snapshot';
import type { TopologyStoreState } from '../state/topology-store';
import { entryMetaText } from '../topology/view-model';
import { deviceSidebarIconSpec } from '../topology/device-visuals';

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
          ${this.#renderDeviceMark(device)}
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

  #renderDeviceMark(device: ViewDevice): TemplateResult {
    const icon = deviceSidebarIconSpec(device);

    return html`
      <span
        class="tree-row__mark"
        data-deployment=${device.deployment_type}
        data-variant=${icon.variant}
      >
        ${svg`<svg viewBox=${icon.viewBox} aria-hidden="true" focusable="false">
          ${icon.topPath
            ? svg`<path class="tree-row__mark-top" d=${icon.topPath}></path>`
            : null}
          ${icon.frontPath
            ? svg`<path class="tree-row__mark-front" d=${icon.frontPath}></path>`
            : null}
          ${icon.sidePath
            ? svg`<path class="tree-row__mark-side" d=${icon.sidePath}></path>`
            : null}
          ${icon.bodyPath
            ? svg`<path class="tree-row__mark-body" d=${icon.bodyPath}></path>`
            : null}
        </svg>`}
      </span>
    `;
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
