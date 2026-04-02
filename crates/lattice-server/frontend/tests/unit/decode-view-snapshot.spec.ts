import { describe, expect, it } from 'vitest';

import { decodeViewSnapshot, EMPTY_SNAPSHOT } from '../../src/topology/decode-view-snapshot';

describe('decodeViewSnapshot', () => {
  it('exposes a stable empty snapshot constant', () => {
    expect(EMPTY_SNAPSHOT.discovery_status.state).toBe('loading');
    expect(EMPTY_SNAPSHOT.devices).toEqual([]);
    expect(EMPTY_SNAPSHOT.links).toEqual([]);
    expect(EMPTY_SNAPSHOT.auto_discovery_interval_seconds).toBe(60);
    expect(EMPTY_SNAPSHOT.next_auto_discovery_at_ms).toBeUndefined();
  });

  it('preserves valid API payloads while applying only structural guards', () => {
    const decoded = decodeViewSnapshot({
      devices: [
        {
          deployment_type: 'virtual',
          device_role: 'server',
          guest_kind: 'vm',
          id: 'guest-app',
          identity_keys: {
            chassis_id: null,
            mac_addresses: ['aa:bb:cc:dd:ee:ff'],
            mgmt_ip: '192.0.2.10',
            sys_name: 'vm-app',
          },
          label: 'vm-app',
          depth: 0,
          host_label: null,
          upstream_interface: null,
        },
      ],
      discovery_status: {
        state: 'ready',
        message: 'synced',
      },
      auto_discovery_interval_seconds: 90,
      next_auto_discovery_at_ms: 1744000000000,
      links: [
        {
          guest_attachment: {
            bridge_name: 'vmbr0',
            trunk_vlans: [120, 130],
            vlan_tag: 120,
          },
          local_device_id: 'guest-app',
          local_interface: 'eth0',
          local_ip: null,
          protocol: 'lldp',
          remote_device_id: 'router-core',
          remote_interface: 'eth0',
          remote_ip: null,
          speed_bps: 1000,
          network_cidrs: ['192.0.2.0/24'],
          id: 'link-1',
        },
      ],
      primary_row_by_device: {
        'guest-app': 'row-1',
      },
      tree_edges: [{ child_row_id: 'row-1', parent_row_id: 'root-1' }],
      tree_rows: [{ device_id: 'guest-app', id: 'row-1', label: 'vm-app' }],
    });

    expect(decoded).toEqual({
      devices: [
        {
          deployment_type: 'virtual',
          device_role: 'server',
          depth: 0,
          guest_kind: 'vm',
          id: 'guest-app',
          identity_keys: {
            chassis_id: null,
            mac_addresses: ['aa:bb:cc:dd:ee:ff'],
            mgmt_ip: '192.0.2.10',
            sys_name: 'vm-app',
          },
          label: 'vm-app',
          host_label: null,
          upstream_interface: null,
        },
      ],
      discovery_status: {
        message: 'synced',
        state: 'ready',
      },
      auto_discovery_interval_seconds: 90,
      next_auto_discovery_at_ms: 1744000000000,
      links: [
        {
          guest_attachment: {
            bridge_name: 'vmbr0',
            trunk_vlans: [120, 130],
            vlan_tag: 120,
          },
          id: 'link-1',
          local_device_id: 'guest-app',
          local_interface: 'eth0',
          local_ip: null,
          protocol: 'lldp',
          remote_device_id: 'router-core',
          remote_interface: 'eth0',
          remote_ip: null,
          speed_bps: 1000,
          network_cidrs: ['192.0.2.0/24'],
        },
      ],
      primary_row_by_device: { 'guest-app': 'row-1' },
      tree_edges: [{ child_row_id: 'row-1', parent_row_id: 'root-1' }],
      tree_rows: [{ device_id: 'guest-app', id: 'row-1', label: 'vm-app' }],
    });
  });

  it('falls back to safe defaults when required containers are missing', () => {
    const decoded = decodeViewSnapshot({
      discovery_status: {
        state: 'invalid',
        message: 42,
      },
      auto_discovery_interval_seconds: 0,
      devices: null,
      links: 'invalid',
      tree_rows: {},
      tree_edges: undefined,
      primary_row_by_device: {
        guest: 'row-1',
        bad: 42,
      },
    });

    expect(decoded.devices).toEqual([]);
    expect(decoded.links).toEqual([]);
    expect(decoded.tree_rows).toEqual([]);
    expect(decoded.tree_edges).toEqual([]);
    expect(decoded.primary_row_by_device).toEqual({ guest: 'row-1' });
    expect(decoded.discovery_status).toEqual({ state: 'loading' });
    expect(decoded.auto_discovery_interval_seconds).toBe(60);
    expect(decoded.next_auto_discovery_at_ms).toBeUndefined();
  });

  it('defaults missing link network cidrs to an empty array', () => {
    const decoded = decodeViewSnapshot({
      devices: [],
      links: [
        {
          id: 'link-1',
          local_device_id: 'device-a',
          local_interface: 'eth0',
          protocol: 'lldp',
          remote_device_id: 'device-b',
          remote_interface: 'eth1',
        },
      ],
      tree_rows: [],
      tree_edges: [],
      primary_row_by_device: {},
      discovery_status: {
        state: 'ready',
      },
      auto_discovery_interval_seconds: 60,
    });

    expect(decoded.links[0]?.network_cidrs).toEqual([]);
  });

  it('returns the stable empty snapshot for non-object payloads', () => {
    expect(decodeViewSnapshot(null)).toBe(EMPTY_SNAPSHOT);
    expect(decodeViewSnapshot([])).toBe(EMPTY_SNAPSHOT);
  });
});
