import { LitElement, html, svg, type PropertyValues, type TemplateResult } from 'lit';

import type { ViewDevice } from '../generated';
import type { TopologyStoreState } from '../state/topology-store';
import { entryMetaText } from '../topology/view-model';
import { deviceSidebarIconSpec } from '../topology/device-visuals';

export class LatticeSidebarTree extends LitElement {
  static properties = {
    state: { attribute: false },
  };

  declare state: TopologyStoreState;
  #selectionScrollFrame: number | null = null;

  createRenderRoot(): this {
    return this;
  }

  disconnectedCallback(): void {
    if (this.#selectionScrollFrame !== null) {
      window.cancelAnimationFrame(this.#selectionScrollFrame);
      this.#selectionScrollFrame = null;
    }
    super.disconnectedCallback();
  }

  updated(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has('state')) {
      return;
    }

    const previousState = changedProperties.get('state') as TopologyStoreState | undefined;
    if (!this.state || this.state.hoverSource !== 'scene') {
      return;
    }

    if (previousState?.selectedEntryId === this.state.selectedEntryId) {
      return;
    }

    if (this.#selectionScrollFrame !== null) {
      window.cancelAnimationFrame(this.#selectionScrollFrame);
    }

    this.#selectionScrollFrame = window.requestAnimationFrame(() => {
      this.#selectionScrollFrame = window.requestAnimationFrame(() => {
        this.#selectionScrollFrame = null;
        this.#scrollSelectedEntryIntoView();
      });
    });
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
      (this.state.hoverSource === 'scene' && this.state.hoveredEntryPeers.has(entry.id));
    const isPeer = this.state.selectedEntryPeers.has(entry.id) && !isSelected;
    const isSelectedPath = this.state.selectedPathEntryIds.has(entry.id);
    const isHoveredPath = this.state.hoveredPathEntryIds.has(entry.id);

    return html`
      <div
        class=${[
          'tree-entry',
          isSelectedPath ? 'is-selected-path' : '',
          isHoveredPath ? 'is-hovered-path' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style=${`--tree-indent:${0.4 + depth * 1.05}rem;`}
      >
        <div class="tree-row-shell">
        <div
          class=${[
            'tree-row',
            isSelected ? 'is-selected' : '',
            isHovered ? 'is-hovered' : '',
            isPeer ? 'is-peer' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-device-id=${entry.device_id}
          data-entry-id=${entry.id}
          role="treeitem"
          aria-expanded=${hasChildren ? String(expanded) : 'false'}
          @click=${(event: MouseEvent) => this.#handleRowClick(event, entry.id)}
          @pointerover=${() => this.#dispatch('entry-hover', { entryId: entry.id })}
        >
          <button
            type="button"
            class=${`tree-toggle ${hasChildren && expanded ? 'is-open' : ''} ${
              hasChildren ? '' : 'tree-toggle--leaf'
            }`}
            aria-label=${hasChildren ? (expanded ? '折りたたむ' : '展開する') : 'leaf'}
            ?disabled=${!hasChildren}
            @click=${(event: MouseEvent) => this.#handleToggleClick(event, entry.id)}
          ></button>

          <button
            type="button"
            class="tree-row__label"
          >
            ${this.#renderDeviceMark(device)}
            <span class="tree-row__copy">
              <span class="tree-row__name">${entry.label || device.label || 'Unknown'}</span>
              <span class="tree-row__meta">${entryMetaText(this.state.model, entry)}</span>
            </span>
          </button>
        </div>
        </div>

        ${hasChildren
          ? html`
              <div class=${`tree-branch ${expanded ? 'is-expanded' : ''}`}>
                <span class="tree-branch__guide" aria-hidden="true"></span>
                <div
                  class=${`tree-children ${expanded ? 'is-expanded' : ''}`}
                  aria-hidden=${String(!expanded)}
                >
                  <div class="tree-children__inner" role="group">
                    ${childIds.map((childEntryId) => this.#renderEntry(childEntryId, depth + 1))}
                  </div>
                </div>
              </div>
            `
          : null}
      </div>
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

  #handleRowClick(event: MouseEvent, entryId: string) {
    const target = event.target;
    if (target instanceof Element && target.closest('.tree-toggle')) {
      return;
    }

    this.#dispatch('entry-primary-action', { entryId });
  }

  #handleToggleClick(event: MouseEvent, entryId: string) {
    event.stopPropagation();
    this.#dispatch('entry-toggle', { entryId });
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

  #scrollSelectedEntryIntoView() {
    const selectedEntryId = this.state.selectedEntryId;
    if (!selectedEntryId) {
      return;
    }

    const tree = this.querySelector<HTMLElement>('.tree');
    const row = this.querySelector<HTMLElement>(`.tree-row[data-entry-id="${selectedEntryId}"]`);
    if (!tree || !row) {
      return;
    }

    const treeRect = tree.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const rowOutsideViewport = rowRect.top < treeRect.top || rowRect.bottom > treeRect.bottom;
    if (!rowOutsideViewport) {
      return;
    }

    row.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }
}

customElements.define('lattice-sidebar-tree', LatticeSidebarTree);
