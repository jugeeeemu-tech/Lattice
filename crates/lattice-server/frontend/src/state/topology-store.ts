import type { ViewSnapshot } from '../model/view-snapshot';
import { EMPTY_SNAPSHOT } from '../topology/decode-view-snapshot';
import {
  buildEmptyState,
  buildHoverCardForDevice,
  buildHoverCardForEntry,
  buildHoverCardForLink,
  buildStatusMessage,
  buildSummaryText,
  buildTopologyModel,
  computeUpstreamPath,
  entryMetaText,
  nearestVisibleAncestorRowId,
  pathEntryIdsForRow,
  preferredEntryForDevice,
  preferredRowForDevice,
  type SidebarEntry,
  statusLabel,
  STATUS_THEME,
  type DerivedTopologyModel,
  type EmptyState,
  type HoverCardState,
  type PathState,
} from '../topology/view-model';

export type HoverSource = 'scene' | 'tree' | null;
export type SnapshotSource = 'boot' | 'http' | 'polling' | 'ws';
export type TransportMode = 'idle' | 'polling' | 'websocket';

export interface TopologyStoreState {
  collapsedEntryIds: ReadonlySet<string>;
  discoverButtonDisabled: boolean;
  discoverButtonLabel: string;
  emptyState: EmptyState | null;
  hoveredEntryPeers: ReadonlySet<string>;
  hoveredPath: PathState;
  hoveredPathEntryIds: ReadonlySet<string>;
  hoverCard: HoverCardState | null;
  hoverSource: HoverSource;
  hoveredDeviceId: string | null;
  hoveredEntryId: string | null;
  hoveredLinkId: string | null;
  hoveredRowId: string | null;
  model: DerivedTopologyModel;
  selectedDeviceId: string | null;
  selectedEntryId: string | null;
  selectedEntryPeers: ReadonlySet<string>;
  selectedPath: PathState;
  selectedPathEntryIds: ReadonlySet<string>;
  selectedRowId: string | null;
  snapshot: ViewSnapshot;
  statusLabel: string;
  statusMessage: string;
  statusTheme: { bg: string; fg: string; label: string };
  summaryText: string;
  transport: {
    mode: TransportMode;
    note: string;
  };
  viewportReady: boolean;
}

type Listener = (state: TopologyStoreState) => void;

export class TopologyStore {
  #listeners = new Set<Listener>();
  #snapshot: ViewSnapshot = EMPTY_SNAPSHOT;
  #model = buildTopologyModel(EMPTY_SNAPSHOT, new Set<string>());
  #collapsedEntryIds = new Set<string>();

  #selectedEntryId: string | null = null;
  #selectedRowId: string | null = null;
  #selectedDeviceId: string | null = null;
  #hoveredEntryId: string | null = null;
  #hoveredRowId: string | null = null;
  #hoveredDeviceId: string | null = null;
  #hoveredLinkId: string | null = null;
  #hoverSource: HoverSource = null;
  #hoverPointer = { x: 20, y: 20 };
  #transport = {
    mode: 'idle' as TransportMode,
    note: '初期化中',
  };
  #state = this.#computeState();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getState(): TopologyStoreState {
    return this.#state;
  }

  setTransport(mode: TransportMode, note: string): void {
    this.#transport = { mode, note };
    this.#emit();
  }

  applySnapshot(snapshot: ViewSnapshot, source: SnapshotSource): void {
    this.#snapshot = snapshot;
    this.#rebuildModel();
    this.#syncSelectionAfterSnapshot();

    this.#transport = {
      mode: source === 'ws' ? 'websocket' : this.#transport.mode,
      note: source === 'ws' ? 'Live snapshot received' : 'Snapshot loaded',
    };

    this.#emit();
  }

  applyFailureState(message: string): void {
    this.#snapshot = {
      ...this.#snapshot,
      discovery_status: {
        state: 'failed',
        message,
      },
    };
    this.#rebuildModel();
    this.#syncSelectionAfterSnapshot();
    this.#transport = {
      ...this.#transport,
      note: message,
    };
    this.#emit();
  }

  toggleCollapse(entryId: string): void {
    this.#toggleCollapsedEntry(entryId);
    this.#rebuildModel();
    this.#syncSelectionAfterSnapshot();
    this.#emit();
  }

  selectEntry(
    entryId: string,
    options: { reveal?: boolean; source?: Exclude<HoverSource, null> } = {}
  ): void {
    const entry = this.#model.sidebarEntryById.get(entryId);
    if (!entry) {
      return;
    }

    if (options.reveal) {
      this.#revealEntry(entry.id);
    }

    this.#setSelectionState(
      this.#model.sidebarEntryById.get(entry.id) ?? entry,
      options.source ?? 'tree'
    );
    this.#emit();
  }

  activateEntry(
    entryId: string,
    options: { source?: Exclude<HoverSource, null> } = {}
  ): void {
    const entry = this.#model.sidebarEntryById.get(entryId);
    if (!entry) {
      return;
    }

    const hasChildren = (this.#model.sidebarChildrenById.get(entry.id) ?? []).length > 0;
    if (hasChildren) {
      this.#toggleCollapsedEntry(entry.id);
      this.#rebuildModel();
    }

    this.#setSelectionState(
      this.#model.sidebarEntryById.get(entry.id) ?? entry,
      options.source ?? 'tree'
    );
    this.#emit();
  }

  hoverEntry(entryId: string): void {
    const entry = this.#model.sidebarEntryById.get(entryId);
    if (!entry) {
      return;
    }

    this.#hoverSource = 'tree';
    this.#hoveredEntryId = entry.id;
    this.#hoveredDeviceId = entry.device_id;
    this.#hoveredRowId = entry.tree_row_id ?? preferredRowForDevice(this.#model, entry.device_id);
    this.#hoveredLinkId = null;
    this.#emit();
  }

  hoverSceneDevice(deviceId: string, pointer?: { x: number; y: number }): void {
    this.#hoverSource = 'scene';
    this.#hoveredDeviceId = deviceId;
    this.#hoveredLinkId = null;
    this.#hoveredEntryId = preferredEntryForDevice(this.#model, deviceId);
    this.#hoveredRowId = preferredRowForDevice(this.#model, deviceId);
    if (pointer) {
      this.#hoverPointer = pointer;
    }
    this.#emit();
  }

  hoverSceneLink(linkId: string, pointer?: { x: number; y: number }): void {
    this.#hoverSource = 'scene';
    this.#hoveredDeviceId = null;
    this.#hoveredLinkId = linkId;
    this.#hoveredEntryId = null;
    this.#hoveredRowId = null;
    if (pointer) {
      this.#hoverPointer = pointer;
    }
    this.#emit();
  }

  updateScenePointer(pointer: { x: number; y: number }): void {
    this.#hoverPointer = pointer;
    if (this.#hoverSource === 'scene' && (this.#hoveredDeviceId || this.#hoveredLinkId)) {
      this.#emit();
    }
  }

  clearHover(expectedSource?: Exclude<HoverSource, null>): void {
    if (expectedSource && this.#hoverSource !== expectedSource) {
      return;
    }

    this.#hoverSource = null;
    this.#hoveredEntryId = null;
    this.#hoveredRowId = null;
    this.#hoveredDeviceId = null;
    this.#hoveredLinkId = null;
    this.#emit();
  }

  entryMetaText(entryId: string): string {
    const entry = this.#model.sidebarEntryById.get(entryId);
    return entry ? entryMetaText(this.#model, entry) : '';
  }

  #emit(): void {
    this.#state = this.#computeState();
    for (const listener of this.#listeners) {
      listener(this.#state);
    }
  }

  #rebuildModel(): void {
    this.#model = buildTopologyModel(this.#snapshot, this.#collapsedEntryIds);
  }

  #setSelectionState(entry: SidebarEntry, source: Exclude<HoverSource, null>): void {
    this.#selectedEntryId = entry.id;
    this.#selectedDeviceId = entry.device_id;
    this.#selectedRowId =
      entry.tree_row_id ?? preferredRowForDevice(this.#model, entry.device_id);

    this.#hoverSource = source;
    this.#hoveredEntryId = entry.id;
    this.#hoveredDeviceId = entry.device_id;
    this.#hoveredRowId = this.#selectedRowId;
    this.#hoveredLinkId = null;
  }

  #toggleCollapsedEntry(entryId: string): void {
    if (this.#collapsedEntryIds.has(entryId)) {
      this.#collapsedEntryIds.delete(entryId);
    } else {
      this.#collapsedEntryIds.add(entryId);
    }
  }

  #revealEntry(entryId: string): void {
    const entry = this.#model.sidebarEntryById.get(entryId);
    if (!entry?.tree_row_id) {
      return;
    }

    for (const pathEntryId of pathEntryIdsForRow(this.#model, entry.tree_row_id)) {
      this.#collapsedEntryIds.delete(pathEntryId);
    }

    this.#rebuildModel();
  }

  #syncSelectionAfterSnapshot(): void {
    const validDeviceIds = this.#model.renderableDeviceIds;

    if (this.#selectedDeviceId && !validDeviceIds.has(this.#selectedDeviceId)) {
      this.#selectedDeviceId = null;
      this.#selectedEntryId = null;
      this.#selectedRowId = null;
    } else if (this.#selectedDeviceId) {
      const entryIds = this.#model.entryIdsByDeviceId.get(this.#selectedDeviceId) ?? [];
      if (!entryIds.includes(this.#selectedEntryId ?? '')) {
        this.#selectedEntryId = preferredEntryForDevice(this.#model, this.#selectedDeviceId);
      }
      this.#selectedRowId = preferredRowForDevice(this.#model, this.#selectedDeviceId);
    }

    if (this.#selectedRowId && !this.#model.visibleRowIds.has(this.#selectedRowId)) {
      const visibleAncestorRowId = nearestVisibleAncestorRowId(this.#model, this.#selectedRowId);
      if (visibleAncestorRowId) {
        const visibleAncestor = this.#model.rowById.get(visibleAncestorRowId) ?? null;
        this.#selectedRowId = visibleAncestorRowId;
        this.#selectedEntryId =
          this.#model.treeEntryIdByRowId.get(visibleAncestorRowId) ?? null;
        this.#selectedDeviceId = visibleAncestor?.device_id ?? null;
        this.#clearHoverState();
      } else {
        this.#selectedDeviceId = null;
        this.#selectedEntryId = null;
        this.#selectedRowId = null;
      }
    }

    if (this.#selectedDeviceId && !this.#model.sceneDeviceIds.has(this.#selectedDeviceId)) {
      this.#selectedDeviceId = null;
      this.#selectedEntryId = null;
      this.#selectedRowId = null;
    }

    if (this.#hoveredDeviceId && !validDeviceIds.has(this.#hoveredDeviceId)) {
      this.#clearHoverState();
    } else if (this.#hoveredDeviceId) {
      const entryIds = this.#model.entryIdsByDeviceId.get(this.#hoveredDeviceId) ?? [];
      if (this.#hoveredEntryId && !entryIds.includes(this.#hoveredEntryId)) {
        this.#hoveredEntryId = null;
      }
      this.#hoveredRowId = preferredRowForDevice(this.#model, this.#hoveredDeviceId);
    }

    if (this.#hoveredRowId && !this.#model.visibleRowIds.has(this.#hoveredRowId)) {
      this.#clearHoverState();
    }

    if (
      this.#hoveredLinkId &&
      (!this.#snapshot.links.some((link) => link.id === this.#hoveredLinkId) ||
        !this.#model.visibleLinkIds.has(this.#hoveredLinkId))
    ) {
      this.#hoveredLinkId = null;
    }
  }

  #clearHoverState(): void {
    this.#hoverSource = null;
    this.#hoveredEntryId = null;
    this.#hoveredRowId = null;
    this.#hoveredDeviceId = null;
    this.#hoveredLinkId = null;
  }

  #computeHoverCard(): HoverCardState | null {
    if (this.#hoverSource === 'tree' && this.#hoveredEntryId) {
      return buildHoverCardForEntry(this.#model, this.#hoveredEntryId);
    }
    if (this.#hoveredLinkId) {
      return buildHoverCardForLink(
        this.#snapshot,
        this.#model,
        this.#hoveredLinkId,
        this.#hoverPointer
      );
    }
    if (this.#hoveredDeviceId) {
      return buildHoverCardForDevice(this.#model, this.#hoveredDeviceId, this.#hoverPointer);
    }
    return null;
  }

  #computeState(): TopologyStoreState {
    const selectedPath = computeUpstreamPath(
      this.#snapshot,
      this.#model,
      this.#selectedDeviceId
    );
    const hoveredPath = computeUpstreamPath(
      this.#snapshot,
      this.#model,
      this.#hoveredDeviceId
    );
    const statusState = this.#snapshot.discovery_status.state;

    return {
      collapsedEntryIds: new Set(this.#collapsedEntryIds),
      discoverButtonDisabled: statusState === 'discovering',
      discoverButtonLabel: statusState === 'discovering' ? '探索中' : '再探索',
      emptyState: buildEmptyState(this.#snapshot, this.#model.sceneDeviceIds.size),
      hoveredDeviceId: this.#hoveredDeviceId,
      hoveredEntryId: this.#hoveredEntryId,
      hoveredEntryPeers: new Set(
        this.#model.entryIdsByDeviceId.get(this.#hoveredDeviceId ?? '') ?? []
      ),
      hoveredLinkId: this.#hoveredLinkId,
      hoveredPath,
      hoveredPathEntryIds: pathEntryIdsForRow(this.#model, this.#hoveredRowId),
      hoveredRowId: this.#hoveredRowId,
      hoverCard: this.#computeHoverCard(),
      hoverSource: this.#hoverSource,
      model: this.#model,
      selectedDeviceId: this.#selectedDeviceId,
      selectedEntryId: this.#selectedEntryId,
      selectedEntryPeers: new Set(
        this.#model.entryIdsByDeviceId.get(this.#selectedDeviceId ?? '') ?? []
      ),
      selectedPath,
      selectedPathEntryIds: pathEntryIdsForRow(this.#model, this.#selectedRowId),
      selectedRowId: this.#selectedRowId,
      snapshot: this.#snapshot,
      statusLabel: statusLabel(statusState),
      statusMessage: buildStatusMessage(this.#snapshot),
      statusTheme: STATUS_THEME[statusState],
      summaryText: buildSummaryText(this.#model),
      transport: { ...this.#transport },
      viewportReady: this.#model.sceneDeviceIds.size > 0,
    };
  }
}
