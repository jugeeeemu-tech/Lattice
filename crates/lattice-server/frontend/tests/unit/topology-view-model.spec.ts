import { describe, expect, it } from 'vitest';

import type { ViewSnapshot } from '../../src/generated';
import {
  buildTopologyModel,
  computeUpstreamPath,
  deviceSummary,
  entryMetaText,
  networkCidrColor,
  preferredEntryForDevice,
  preferredRowForDevice,
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
          network_cidrs: ['192.0.2.0/24', '198.51.100.0/24'],
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
      trunkLinkId: 'link-pve-router-trunk',
    });
    expect(path.resolvedNetworkCidrByLink).toEqual({
      'link-pve-guest': '192.0.2.0/24',
      'link-pve-router-trunk': '192.0.2.0/24',
    });
  });

  it('includes untagged guest links in the upstream path and continues through the host uplink', async () => {
    const snapshot = await loadViewSnapshotFixture('populated');
    const untaggedSnapshot = {
      ...snapshot,
      links: [
        snapshot.links[0],
        {
          ...snapshot.links[1],
          guest_attachment: {
            bridge_name: 'vmbr0',
            trunk_vlans: [120, 130],
          },
        },
      ],
    };
    const model = buildTopologyModel(untaggedSnapshot, new Set());

    const path = computeUpstreamPath(untaggedSnapshot, model, 'guest-app');

    expect(Array.from(path.deviceIds).sort()).toEqual(['guest-app', 'proxmox-host', 'router-core']);
    expect(Array.from(path.linkIds).sort()).toEqual(['link-core-pve', 'link-pve-guest']);
    expect(path.guestHighlight).toBeNull();
    expect(path.resolvedNetworkCidrByLink).toEqual({
      'link-core-pve': '192.0.2.0/24',
      'link-pve-guest': '192.0.2.0/24',
    });
  });

  it('prefers a plain guest uplink over a trunk guest uplink for virtual routers', async () => {
    const snapshot = await loadViewSnapshotFixture('populated');
    const routerGuestSnapshot = {
      ...snapshot,
      devices: [
        {
          ...snapshot.devices[2],
          device_role: 'router' as const,
          label: 'vyos01',
        },
        snapshot.devices[1],
        snapshot.devices[0],
      ],
      links: [
        snapshot.links[0],
        {
          id: 'link-vyos-net0',
          local_device_id: 'guest-app',
          local_interface: 'net0',
          remote_device_id: 'proxmox-host',
          remote_interface: 'vmbr0',
          speed_bps: 1_000_000_000,
          protocol: 'proxmox_guest_link',
          network_cidrs: ['10.20.0.0/24'],
          guest_attachment: {
            bridge_name: 'vmbr0',
          },
        },
        {
          id: 'link-vyos-net1',
          local_device_id: 'guest-app',
          local_interface: 'net1',
          remote_device_id: 'proxmox-host',
          remote_interface: 'vmbr0',
          speed_bps: 1_000_000_000,
          protocol: 'proxmox_guest_link',
          network_cidrs: ['10.20.30.0/24', '10.20.40.0/24'],
          guest_attachment: {
            bridge_name: 'vmbr0',
            trunk_vlans: [20, 30],
          },
        },
      ],
    };
    const model = buildTopologyModel(routerGuestSnapshot, new Set());

    const path = computeUpstreamPath(routerGuestSnapshot, model, 'guest-app');

    expect(Array.from(path.deviceIds).sort()).toEqual(['guest-app', 'proxmox-host', 'router-core']);
    expect(Array.from(path.linkIds).sort()).toEqual(['link-core-pve', 'link-vyos-net0']);
    expect(path.guestHighlight).toBeNull();
    expect(path.resolvedNetworkCidrByLink).toEqual({
      'link-core-pve': '192.0.2.0/24',
      'link-vyos-net0': '10.20.0.0/24',
    });
  });

  it('derives stable colors from L3 network cidrs', () => {
    expect(networkCidrColor('192.0.2.0/24')).toBe(networkCidrColor('192.0.2.0/24'));
    expect(networkCidrColor('192.0.2.0/24')).not.toBe(networkCidrColor('198.51.100.0/24'));
    expect(networkCidrColor(null)).toBeNull();
  });

  it('maps tagged guest access to the matching trunk network when access ip data is absent', async () => {
    const snapshot = await loadViewSnapshotFixture('populated');
    const mappedSnapshot = {
      ...snapshot,
      links: [
        snapshot.links[0],
        {
          ...snapshot.links[1],
          network_cidrs: [],
        },
        {
          id: 'link-pve-router-trunk',
          local_device_id: 'proxmox-host',
          local_interface: 'vmbr0',
          remote_device_id: 'router-core',
          remote_interface: 'vlan120',
          speed_bps: 1_000_000_000,
          protocol: 'proxmox_guest_link',
          network_cidrs: ['10.120.0.0/24', '10.130.0.0/24'],
          guest_attachment: {
            bridge_name: 'vmbr0',
            trunk_vlans: [120, 130],
          },
        },
      ],
    };
    const model = buildTopologyModel(mappedSnapshot, new Set());

    const path = computeUpstreamPath(mappedSnapshot, model, 'guest-app');

    expect(path.resolvedNetworkCidrByLink).toEqual({
      'link-pve-guest': '10.120.0.0/24',
      'link-pve-router-trunk': '10.120.0.0/24',
    });
  });

  it('continues from intermediate physical devices to their primary tree parent', () => {
    const snapshot: ViewSnapshot = {
      auto_discovery_interval_seconds: 30,
      next_auto_discovery_at_ms: 0,
      discovery_status: {
        state: 'ready',
      },
      devices: [
        {
          id: 'core-router',
          label: 'core-router',
          depth: 0,
          device_role: 'router',
          deployment_type: 'physical',
          upstream_interface: 'wan0',
          identity_keys: {
            sys_name: 'core-router',
            mgmt_ip: '10.0.0.1',
            mac_addresses: ['00:00:5e:00:53:01'],
          },
        },
        {
          id: 'dist-switch',
          label: 'dist-switch',
          depth: 1,
          device_role: 'switch',
          deployment_type: 'physical',
          identity_keys: {
            sys_name: 'dist-switch',
            mgmt_ip: '10.0.1.2',
            mac_addresses: ['00:00:5e:00:53:02'],
          },
        },
        {
          id: 'access-switch',
          label: 'access-switch',
          depth: 2,
          device_role: 'switch',
          deployment_type: 'physical',
          identity_keys: {
            sys_name: 'access-switch',
            mgmt_ip: '10.0.1.3',
            mac_addresses: ['00:00:5e:00:53:03'],
          },
        },
        {
          id: 'app-server',
          label: 'app-server',
          depth: 3,
          device_role: 'server',
          deployment_type: 'physical',
          identity_keys: {
            sys_name: 'app-server',
            mgmt_ip: '10.0.1.4',
            mac_addresses: ['00:00:5e:00:53:04'],
          },
        },
      ],
      links: [
        {
          id: 'core-dist',
          local_device_id: 'core-router',
          local_interface: 'lan0',
          local_ip: '10.0.1.1/24',
          remote_device_id: 'dist-switch',
          remote_interface: 'eth1',
          remote_ip: '10.0.1.2/24',
          speed_bps: 1_000_000_000,
          protocol: 'lldp',
          network_cidrs: ['10.0.1.0/24'],
        },
        {
          id: 'dist-access',
          local_device_id: 'dist-switch',
          local_interface: 'eth2',
          local_ip: '10.0.1.2/24',
          remote_device_id: 'access-switch',
          remote_interface: 'eth1',
          remote_ip: '10.0.1.3/24',
          speed_bps: 1_000_000_000,
          protocol: 'lldp',
          network_cidrs: ['10.0.1.0/24'],
        },
        {
          id: 'dist-app',
          local_device_id: 'dist-switch',
          local_interface: 'eth3',
          local_ip: '10.0.1.2/24',
          remote_device_id: 'app-server',
          remote_interface: 'eth0',
          remote_ip: '10.0.1.4/24',
          speed_bps: 1_000_000_000,
          protocol: 'lldp',
          network_cidrs: ['10.0.1.0/24'],
        },
      ],
      tree_rows: [
        { id: 'row-core', device_id: 'core-router', label: 'core-router' },
        { id: 'row-dist', device_id: 'dist-switch', label: 'dist-switch' },
        { id: 'row-access', device_id: 'access-switch', label: 'access-switch' },
        { id: 'row-app', device_id: 'app-server', label: 'app-server' },
      ],
      tree_edges: [
        { parent_row_id: 'row-core', child_row_id: 'row-dist' },
        { parent_row_id: 'row-dist', child_row_id: 'row-access' },
        { parent_row_id: 'row-dist', child_row_id: 'row-app' },
      ],
      root_device_ids: ['core-router'],
      device_relations: {
        'core-router': { parents: [], peers: [], children: ['dist-switch'] },
        'dist-switch': {
          parents: ['core-router'],
          peers: [],
          children: ['access-switch', 'app-server'],
        },
        'access-switch': { parents: ['dist-switch'], peers: [], children: [] },
        'app-server': { parents: ['dist-switch'], peers: [], children: [] },
      },
      primary_row_by_device: {
        'core-router': 'row-core',
        'dist-switch': 'row-dist',
        'access-switch': 'row-access',
        'app-server': 'row-app',
      },
    };
    const model = buildTopologyModel(snapshot, new Set());

    const distPath = computeUpstreamPath(snapshot, model, 'dist-switch');
    const accessPath = computeUpstreamPath(snapshot, model, 'access-switch');

    expect(Array.from(distPath.deviceIds).sort()).toEqual(['core-router', 'dist-switch']);
    expect(Array.from(distPath.linkIds)).toEqual(['core-dist']);
    expect(distPath.resolvedNetworkCidrByLink).toEqual({
      'core-dist': '10.0.1.0/24',
    });

    expect(Array.from(accessPath.deviceIds).sort()).toEqual([
      'access-switch',
      'core-router',
      'dist-switch',
    ]);
    expect(Array.from(accessPath.linkIds).sort()).toEqual(['core-dist', 'dist-access']);
    expect(accessPath.resolvedNetworkCidrByLink).toEqual({
      'core-dist': '10.0.1.0/24',
      'dist-access': '10.0.1.0/24',
    });
  });

  it('keeps multiple sidebar entries for a shared downstream subtree', () => {
    const snapshot: ViewSnapshot = {
      auto_discovery_interval_seconds: 30,
      next_auto_discovery_at_ms: 0,
      discovery_status: {
        state: 'ready',
      },
      devices: [
        {
          id: 'core-router-1',
          label: 'core-router-1',
          depth: 0,
          device_role: 'router',
          deployment_type: 'physical',
          identity_keys: {
            sys_name: 'core-router-1',
            mgmt_ip: '10.0.0.1',
            mac_addresses: ['00:00:5e:00:60:01'],
          },
        },
        {
          id: 'core-router-2',
          label: 'core-router-2',
          depth: 0,
          device_role: 'router',
          deployment_type: 'physical',
          identity_keys: {
            sys_name: 'core-router-2',
            mgmt_ip: '10.0.0.2',
            mac_addresses: ['00:00:5e:00:60:02'],
          },
        },
        {
          id: 'dist-switch-a',
          label: 'dist-switch-a',
          depth: 1,
          device_role: 'switch',
          deployment_type: 'physical',
          identity_keys: {
            sys_name: 'dist-switch-a',
            mgmt_ip: '10.0.1.2',
            mac_addresses: ['00:00:5e:00:60:03'],
          },
        },
        {
          id: 'access-switch-a1',
          label: 'access-switch-a1',
          depth: 2,
          device_role: 'switch',
          deployment_type: 'physical',
          identity_keys: {
            sys_name: 'access-switch-a1',
            mgmt_ip: '10.0.1.3',
            mac_addresses: ['00:00:5e:00:60:04'],
          },
        },
      ],
      links: [
        {
          id: 'core1-dist',
          local_device_id: 'core-router-1',
          local_interface: 'eth1',
          remote_device_id: 'dist-switch-a',
          remote_interface: 'eth1',
          protocol: 'lldp',
          network_cidrs: ['10.0.1.0/24'],
          speed_bps: 1_000_000_000,
        },
        {
          id: 'core2-dist',
          local_device_id: 'core-router-2',
          local_interface: 'eth1',
          remote_device_id: 'dist-switch-a',
          remote_interface: 'eth2',
          protocol: 'lldp',
          network_cidrs: ['10.0.1.0/24'],
          speed_bps: 1_000_000_000,
        },
        {
          id: 'dist-access',
          local_device_id: 'dist-switch-a',
          local_interface: 'eth3',
          remote_device_id: 'access-switch-a1',
          remote_interface: 'eth1',
          protocol: 'lldp',
          network_cidrs: ['10.0.1.0/24'],
          speed_bps: 1_000_000_000,
        },
      ],
      tree_rows: [
        { id: 'row-core-1', device_id: 'core-router-1', label: 'core-router-1' },
        { id: 'row-core-2', device_id: 'core-router-2', label: 'core-router-2' },
        { id: 'row-dist-a', device_id: 'dist-switch-a', label: 'dist-switch-a' },
        { id: 'row-core-2/row-dist-a#1', device_id: 'dist-switch-a', label: 'dist-switch-a' },
        { id: 'row-access-a1', device_id: 'access-switch-a1', label: 'access-switch-a1' },
        {
          id: 'row-core-2/row-dist-a#1/access-switch-a1#1',
          device_id: 'access-switch-a1',
          label: 'access-switch-a1',
        },
      ],
      tree_edges: [
        { parent_row_id: 'row-core-1', child_row_id: 'row-dist-a' },
        { parent_row_id: 'row-core-2', child_row_id: 'row-core-2/row-dist-a#1' },
        { parent_row_id: 'row-dist-a', child_row_id: 'row-access-a1' },
        {
          parent_row_id: 'row-core-2/row-dist-a#1',
          child_row_id: 'row-core-2/row-dist-a#1/access-switch-a1#1',
        },
      ],
      root_device_ids: ['core-router-1', 'core-router-2'],
      device_relations: {
        'core-router-1': {
          parents: [],
          peers: ['core-router-2'],
          children: ['dist-switch-a'],
        },
        'core-router-2': {
          parents: [],
          peers: ['core-router-1'],
          children: ['dist-switch-a'],
        },
        'dist-switch-a': {
          parents: ['core-router-1', 'core-router-2'],
          peers: [],
          children: ['access-switch-a1'],
        },
        'access-switch-a1': {
          parents: ['dist-switch-a'],
          peers: [],
          children: [],
        },
      },
      primary_row_by_device: {
        'core-router-1': 'row-core-1',
        'core-router-2': 'row-core-2',
        'dist-switch-a': 'row-dist-a',
        'access-switch-a1': 'row-access-a1',
      },
    };
    const model = buildTopologyModel(snapshot, new Set());

    expect(model.treeRootEntryIds).toEqual(['tree:row-core-1', 'tree:row-core-2']);
    expect(model.rootDeviceIds).toEqual(['core-router-1', 'core-router-2']);
    expect(model.peerIdsByDeviceId.get('core-router-1')).toEqual(['core-router-2']);
    expect(model.parentIdsByDeviceId.get('dist-switch-a')).toEqual([
      'core-router-1',
      'core-router-2',
    ]);
    expect(model.childIdsByDeviceId.get('dist-switch-a')).toEqual(['access-switch-a1']);
    expect(model.entryIdsByDeviceId.get('dist-switch-a')).toEqual([
      'tree:row-dist-a',
      'tree:row-core-2/row-dist-a#1',
    ]);
    expect(model.entryIdsByDeviceId.get('access-switch-a1')).toEqual([
      'tree:row-access-a1',
      'tree:row-core-2/row-dist-a#1/access-switch-a1#1',
    ]);
    expect(preferredEntryForDevice(model, 'dist-switch-a')).toBe('tree:row-dist-a');
    expect(preferredRowForDevice(model, 'core-router-2')).toBe('row-core-2');
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
