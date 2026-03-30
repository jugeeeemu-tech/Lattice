import { describe, expect, it } from 'vitest';

import { decodeViewSnapshot, EMPTY_SNAPSHOT } from '../../src/topology/decode-view-snapshot';

describe('decodeViewSnapshot', () => {
  it('exposes a stable empty snapshot constant', () => {
    expect(EMPTY_SNAPSHOT.discovery_status.state).toBe('loading');
    expect(EMPTY_SNAPSHOT.devices).toEqual([]);
    expect(EMPTY_SNAPSHOT.links).toEqual([]);
    expect(EMPTY_SNAPSHOT.auto_discovery_interval_seconds).toBe(60);
    expect(EMPTY_SNAPSHOT.next_auto_discovery_at_ms).toBeNull();
  });

  it('normalizes incoming payloads into the frontend snapshot shape', () => {
    const decoded = decodeViewSnapshot({
      devices: [
        {
          deployment_type: 'VIRTUAL',
          device_role: 'Server',
          guest_kind: 'VM',
          id: ' guest-app ',
          identity_keys: {
            mac_addresses: ['aa:bb:cc:dd:ee:ff', 'aa:bb:cc:dd:ee:ff'],
            mgmt_ip: ' 192.0.2.10 ',
            sys_name: ' vm-app ',
          },
          label: '',
        },
      ],
      discovery_status: {
        kind: 'READY',
        reason: ' synced ',
      },
      auto_discovery_interval_seconds: '90',
      next_auto_discovery_at_ms: '1744000000000',
      links: [
        {
          guest_attachment: {
            bridge_name: 'vmbr0',
            trunk_vlans: ['120', '120', '130'],
            vlan_tag: '120',
          },
          local_device_id: 'guest-app',
          local_interface: '',
          protocol: 'LLDP',
          remote_device_id: 'router-core',
          remote_interface: 'eth0',
          speed_bps: '1000',
        },
      ],
      primary_row_by_device: {
        ' guest-app ': ' row-1 ',
      },
      tree_edges: [{ child_row_id: 'row-1', parent_row_id: 'root-1' }],
      tree_rows: [{ device_id: 'guest-app', id: 'row-1', label: '' }],
    });

    expect(decoded).toEqual({
      devices: [
        {
          deployment_type: 'virtual',
          device_role: 'server',
          depth: 0,
          guest_kind: 'vm',
          host_label: null,
          id: 'guest-app',
          identity_keys: {
            chassis_id: null,
            mac_addresses: ['aa:bb:cc:dd:ee:ff'],
            mgmt_ip: '192.0.2.10',
            sys_name: 'vm-app',
          },
          label: 'vm-app',
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
          id: 'guest-app||router-core|eth0|LLDP',
          local_device_id: 'guest-app',
          local_interface: 'unknown',
          local_ip: null,
          protocol: 'lldp',
          remote_device_id: 'router-core',
          remote_interface: 'eth0',
          remote_ip: null,
          speed_bps: 1000,
        },
      ],
      primary_row_by_device: { 'guest-app': 'row-1' },
      tree_edges: [{ child_row_id: 'row-1', parent_row_id: 'root-1' }],
      tree_rows: [{ device_id: 'guest-app', id: 'row-1', label: 'Unknown' }],
    });
  });

  it('normalizes an unknown guest kind to null', () => {
    const decoded = decodeViewSnapshot({
      devices: [
        {
          id: 'device-1',
          label: 'device-1',
          device_role: 'server',
          deployment_type: 'virtual',
          guest_kind: 'pod',
          identity_keys: {
            mac_addresses: [],
          },
        },
      ],
      discovery_status: {
        state: 'ready',
      },
      auto_discovery_interval_seconds: 0,
    });

    expect(decoded.devices[0]?.guest_kind).toBeNull();
    expect(decoded.auto_discovery_interval_seconds).toBe(60);
  });
});
