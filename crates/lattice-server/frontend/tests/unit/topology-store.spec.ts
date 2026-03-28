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
    expect(refreshedState.transport.note).toBe('Live snapshot received');
  });
});
