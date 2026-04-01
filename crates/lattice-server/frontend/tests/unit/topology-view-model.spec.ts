import { describe, expect, it } from 'vitest';

import {
  buildTopologyModel,
  computeUpstreamPath,
  deviceSummary,
  entryMetaText,
  guestAttachmentNetworkColor,
} from '../../src/topology/view-model';
import { loadViewSnapshotFixture } from '../helpers/load-view-snapshot-fixture';

describe('buildTopologyModel', () => {
  it('builds dedicated tree entries and sidebar metadata from the shared fixture', async () => {
    const snapshot = await loadViewSnapshotFixture('populated');
    const model = buildTopologyModel(snapshot, new Set());

    expect(model.treeRootEntryIds).toEqual(['tree:seed:192.0.2.1/router-core#1']);
    expect(model.sidebarChildrenById.get('tree:seed:192.0.2.1/router-core#1')).toEqual([
      'tree:seed:192.0.2.1/proxmox-host#1',
    ]);
    expect(
      entryMetaText(model, model.sidebarEntryById.get('tree:seed:192.0.2.1/guest-app#1')!)
    ).toBe('Server · VM · pve-01 上');
    expect(Array.from(model.visibleLinkIds)).toEqual(['link-core-pve', 'link-pve-guest']);
  });

  it('computes upstream path highlights for guest access plus router trunk', async () => {
    const snapshot = await loadViewSnapshotFixture('populated');
    const extendedSnapshot = {
      ...snapshot,
      links: [
        ...snapshot.links,
        {
          id: 'link-pve-router-trunk',
          local_device_id: 'proxmox-host',
          local_interface: 'vmbr0',
          remote_device_id: 'router-core',
          remote_interface: 'vlan120',
          speed_bps: 1_000_000_000,
          protocol: 'proxmox_guest_link',
          guest_attachment: {
            bridge_name: 'vmbr0',
            trunk_vlans: [120, 130],
          },
        },
      ],
    };
    const model = buildTopologyModel(extendedSnapshot, new Set());

    const path = computeUpstreamPath(extendedSnapshot, model, 'guest-app');

    expect(Array.from(path.deviceIds).sort()).toEqual(['guest-app', 'proxmox-host', 'router-core']);
    expect(Array.from(path.linkIds).sort()).toEqual(['link-pve-guest', 'link-pve-router-trunk']);
    expect(path.guestHighlight).toEqual({
      accessLinkId: 'link-pve-guest',
      color: guestAttachmentNetworkColor(extendedSnapshot.links[1]?.guest_attachment ?? null),
      trunkLinkId: 'link-pve-router-trunk',
    });
  });

  it('includes VM and container labels in device summaries when guest kind is present', async () => {
    const snapshot = await loadViewSnapshotFixture('populated');
    const vmSummary = deviceSummary(snapshot.devices.find((device) => device.id === 'guest-app')!);

    expect(vmSummary).toEqual(['Server', 'VM', 'Virtual', 'pve-01 上']);

    const containerSummary = deviceSummary({
      ...snapshot.devices.find((device) => device.id === 'guest-app')!,
      guest_kind: 'container',
      label: 'ct-app-01',
    });

    expect(containerSummary).toEqual(['Server', 'Container', 'Virtual', 'pve-01 上']);
  });
});
