import { describe, expect, it } from 'vitest';

import { TopologyStore } from '../../src/state/topology-store';
import { loadViewSnapshotFixture } from '../helpers/load-view-snapshot-fixture';

describe('TopologyStore', () => {
  it('toggles and selects parent entries when activated from the tree label', async () => {
    const snapshot = await loadViewSnapshotFixture('populated');
    const store = new TopologyStore();

    store.applySnapshot(snapshot, 'http');
    store.activateEntry('tree:seed:192.0.2.1/router-core#1');

    const collapsedState = store.getState();
    expect(collapsedState.collapsedEntryIds.has('tree:seed:192.0.2.1/router-core#1')).toBe(true);
    expect(collapsedState.selectedEntryId).toBe('tree:seed:192.0.2.1/router-core#1');
    expect(collapsedState.selectedDeviceId).toBe('router-core');
    expect(collapsedState.hoveredEntryId).toBe('tree:seed:192.0.2.1/router-core#1');
    expect(collapsedState.model.visibleRowIds.has('seed:192.0.2.1/proxmox-host#1')).toBe(false);

    store.activateEntry('tree:seed:192.0.2.1/router-core#1');

    const expandedState = store.getState();
    expect(expandedState.collapsedEntryIds.has('tree:seed:192.0.2.1/router-core#1')).toBe(false);
    expect(expandedState.selectedEntryId).toBe('tree:seed:192.0.2.1/router-core#1');
    expect(expandedState.selectedDeviceId).toBe('router-core');
    expect(expandedState.model.visibleRowIds.has('seed:192.0.2.1/proxmox-host#1')).toBe(true);
  });

  it('selects leaf entries without changing collapse state when activated from the tree label', async () => {
    const snapshot = await loadViewSnapshotFixture('populated');
    const store = new TopologyStore();

    store.applySnapshot(snapshot, 'http');
    store.activateEntry('tree:seed:192.0.2.1/guest-app#1');

    const state = store.getState();
    expect(state.collapsedEntryIds.size).toBe(0);
    expect(state.selectedEntryId).toBe('tree:seed:192.0.2.1/guest-app#1');
    expect(state.selectedDeviceId).toBe('guest-app');
    expect(state.hoveredEntryId).toBe('tree:seed:192.0.2.1/guest-app#1');
  });

  it('keeps collapsed state across snapshot refresh and reconciles selection to a visible ancestor', async () => {
    const snapshot = await loadViewSnapshotFixture('populated');
    const store = new TopologyStore();

    store.applySnapshot(snapshot, 'http');
    store.selectEntry('tree:seed:192.0.2.1/guest-app#1', {
      reveal: true,
      source: 'tree',
    });
    expect(store.getState().selectedDeviceId).toBe('guest-app');

    store.toggleCollapse('tree:seed:192.0.2.1/router-core#1');
    const collapsedState = store.getState();
    expect(collapsedState.collapsedEntryIds.has('tree:seed:192.0.2.1/router-core#1')).toBe(true);
    expect(collapsedState.selectedDeviceId).toBe('router-core');
    expect(collapsedState.selectedEntryId).toBe('tree:seed:192.0.2.1/router-core#1');

    store.applySnapshot(snapshot, 'ws');
    const refreshedState = store.getState();
    expect(refreshedState.collapsedEntryIds.has('tree:seed:192.0.2.1/router-core#1')).toBe(true);
    expect(refreshedState.selectedDeviceId).toBe('router-core');
    expect(refreshedState.transport.note).toBe('ライブ更新を反映しました');
  });

  it('keeps device and link counters tied to the full discovery result even when some entries are hidden', async () => {
    const snapshot = await loadViewSnapshotFixture('populated');
    const store = new TopologyStore();

    store.applySnapshot(
      {
        ...snapshot,
        devices: [
          ...snapshot.devices,
          {
            ...snapshot.devices[0],
            id: 'hidden-device',
            label: 'hidden-device',
          },
        ],
        links: [
          ...snapshot.links,
          {
            ...snapshot.links[0],
            id: 'hidden-link',
            local_device_id: 'hidden-device',
            remote_device_id: snapshot.devices[0].id,
          },
        ],
      },
      'http'
    );

    const state = store.getState();
    expect(state.deviceCount).toBe(snapshot.devices.length + 1);
    expect(state.visibleLinkCount).toBe(snapshot.links.length + 1);
  });

  it('clears scene link hover state when the hovered link disappears after a snapshot refresh', async () => {
    const snapshot = await loadViewSnapshotFixture('populated');
    const store = new TopologyStore();
    const hoveredLinkId = snapshot.links[0]?.id;

    expect(hoveredLinkId).toBeTruthy();

    store.applySnapshot(snapshot, 'http');
    store.hoverSceneLink(hoveredLinkId!);

    const hoveredState = store.getState();
    expect(hoveredState.hoverSource).toBe('scene');
    expect(hoveredState.hoveredLinkId).toBe(hoveredLinkId);

    store.applySnapshot(
      {
        ...snapshot,
        links: snapshot.links.filter((link) => link.id !== hoveredLinkId),
      },
      'ws'
    );

    const refreshedState = store.getState();
    expect(refreshedState.hoveredLinkId).toBeNull();
    expect(refreshedState.hoverSource).toBeNull();
    expect(refreshedState.hoverCard).toBeNull();
  });

  it('clears tree hover state when the hovered entry disappears even if the device still exists', async () => {
    const snapshot = await loadViewSnapshotFixture('populated');
    const store = new TopologyStore();
    const hoveredEntryId = 'tree:seed:192.0.2.1/guest-app#1';

    store.applySnapshot(snapshot, 'http');
    store.hoverEntry(hoveredEntryId);

    const hoveredState = store.getState();
    expect(hoveredState.hoverSource).toBe('tree');
    expect(hoveredState.hoveredEntryId).toBe(hoveredEntryId);
    expect(hoveredState.hoveredDeviceId).toBe('guest-app');

    const refreshedSnapshot = {
      ...snapshot,
      tree_rows: snapshot.tree_rows.map((row) =>
        row.id === 'seed:192.0.2.1/guest-app#1' ? { ...row, id: 'seed:192.0.2.1/guest-app#2' } : row
      ),
      tree_edges: snapshot.tree_edges.map((edge) => ({
        parent_row_id: edge.parent_row_id === 'seed:192.0.2.1/guest-app#1' ? 'seed:192.0.2.1/guest-app#2' : edge.parent_row_id,
        child_row_id: edge.child_row_id === 'seed:192.0.2.1/guest-app#1' ? 'seed:192.0.2.1/guest-app#2' : edge.child_row_id,
      })),
      primary_row_by_device: {
        ...snapshot.primary_row_by_device,
        'guest-app': 'seed:192.0.2.1/guest-app#2',
      },
    };

    store.applySnapshot(refreshedSnapshot, 'ws');

    const refreshedState = store.getState();
    expect(refreshedState.hoverSource).toBeNull();
    expect(refreshedState.hoveredEntryId).toBeNull();
    expect(refreshedState.hoveredDeviceId).toBeNull();
    expect(refreshedState.hoverCard).toBeNull();
  });
});
