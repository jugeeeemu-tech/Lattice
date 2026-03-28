import { describe, expect, it } from 'vitest';

import { TopologyStore } from '../../src/state/topology-store';
import { loadViewSnapshotFixture } from '../helpers/load-view-snapshot-fixture';

describe('TopologyStore', () => {
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
