import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import type { ViewDevice, ViewLink } from '../../src/generated';
import {
  buildRelationLayoutGraph,
  buildRelationRootAnchors,
  computeParallelLinkOffsets,
  recenterPositionsAroundRootCentroid,
} from '../../src/scene/topology-scene';

describe('computeParallelLinkOffsets', () => {
  it('spreads same-pair links symmetrically and deterministically', () => {
    const links: ViewLink[] = [
      {
        id: 'link-b',
        local_device_id: 'device-a',
        local_interface: 'eth1',
        protocol: 'proxmox_guest_link',
        network_cidrs: [],
        remote_device_id: 'device-b',
        remote_interface: 'eth2',
      },
      {
        id: 'link-a',
        local_device_id: 'device-a',
        local_interface: 'eth0',
        protocol: 'proxmox_guest_link',
        network_cidrs: [],
        remote_device_id: 'device-b',
        remote_interface: 'eth1',
      },
      {
        id: 'link-c',
        local_device_id: 'device-b',
        local_interface: 'eth3',
        protocol: 'proxmox_guest_link',
        network_cidrs: [],
        remote_device_id: 'device-a',
        remote_interface: 'eth4',
      },
      {
        id: 'link-other',
        local_device_id: 'device-a',
        local_interface: 'eth5',
        protocol: 'lldp',
        network_cidrs: ['192.0.2.0/24'],
        remote_device_id: 'device-c',
        remote_interface: 'eth1',
      },
    ];

    const offsets = computeParallelLinkOffsets(links);

    expect(offsets.get('link-a')).toBeCloseTo(-0.48);
    expect(offsets.get('link-b')).toBeCloseTo(0);
    expect(offsets.get('link-c')).toBeCloseTo(0.48);
    expect(offsets.get('link-other')).toBeCloseTo(0);
  });
});

describe('recenterPositionsAroundRootCentroid', () => {
  it('moves the root group centroid back to the origin', () => {
    const positions = new Map([
      ['root-a', new Vector3(6, 0, 3)],
      ['root-b', new Vector3(14, 0, 7)],
      ['child-a', new Vector3(4, -5, 1)],
      ['child-b', new Vector3(18, -5, 9)],
    ]);

    recenterPositionsAroundRootCentroid(positions, ['root-a', 'root-b']);

    const rootA = positions.get('root-a');
    const rootB = positions.get('root-b');
    expect(rootA?.x).toBeCloseTo(-4);
    expect(rootA?.z).toBeCloseTo(-2);
    expect(rootB?.x).toBeCloseTo(4);
    expect(rootB?.z).toBeCloseTo(2);

    const rootCentroid = new Vector3()
      .add(rootA ?? new Vector3())
      .add(rootB ?? new Vector3())
      .multiplyScalar(0.5);
    expect(rootCentroid.x).toBeCloseTo(0);
    expect(rootCentroid.z).toBeCloseTo(0);

    const childA = positions.get('child-a');
    const childB = positions.get('child-b');
    expect(childA?.x).toBeCloseTo(-6);
    expect(childA?.z).toBeCloseTo(-4);
    expect(childB?.x).toBeCloseTo(8);
    expect(childB?.z).toBeCloseTo(4);
  });
});

describe('buildRelationLayoutGraph', () => {
  function device(id: string, label: string): ViewDevice {
    return {
      id,
      label,
      depth: 0,
      deployment_type: 'unknown',
      device_role: label.includes('router') ? 'router' : label.includes('switch') ? 'switch' : 'server',
      guest_kind: undefined,
      host_label: undefined,
      identity_keys: {
        chassis_id: undefined,
        mac_addresses: [],
        mgmt_ip: undefined,
        sys_name: label,
      },
      upstream_interface: undefined,
    };
  }

  it('distributes shared descendants across both roots', () => {
    const deviceById = new Map<string, ViewDevice>([
      ['core-1', device('core-1', 'core-router-1')],
      ['core-2', device('core-2', 'core-router-2')],
      ['dist-a', device('dist-a', 'dist-switch-a')],
      ['access-a1', device('access-a1', 'access-switch-a1')],
      ['app-1', device('app-1', 'app-server-01')],
    ]);

    const graph = buildRelationLayoutGraph(
      ['core-1', 'core-2', 'dist-a', 'access-a1', 'app-1'],
      {
        childIdsByDeviceId: new Map([
          ['core-1', ['dist-a']],
          ['core-2', ['dist-a']],
          ['dist-a', ['access-a1']],
          ['access-a1', ['app-1']],
          ['app-1', []],
        ]),
        deviceById,
        parentIdsByDeviceId: new Map([
          ['core-1', []],
          ['core-2', []],
          ['dist-a', ['core-1', 'core-2']],
          ['access-a1', ['dist-a']],
          ['app-1', ['access-a1']],
        ]),
        peerIdsByDeviceId: new Map([
          ['core-1', ['core-2']],
          ['core-2', ['core-1']],
          ['dist-a', []],
          ['access-a1', []],
          ['app-1', []],
        ]),
        primaryChildrenByDeviceId: new Map(),
        primaryParentDeviceById: new Map(),
        rootDeviceIds: ['core-1', 'core-2'],
      }
    );

    expect(graph.rootDeviceIds).toEqual(['core-1', 'core-2']);
    expect(graph.depthByDeviceId.get('dist-a')).toBe(1);
    expect(graph.depthByDeviceId.get('access-a1')).toBe(2);
    expect(graph.rootDescendantIdsByRootId.get('core-1')).toEqual([
      'access-a1',
      'app-1',
      'core-1',
      'dist-a',
    ]);
    expect(graph.rootDescendantIdsByRootId.get('core-2')).toEqual([
      'access-a1',
      'app-1',
      'core-2',
      'dist-a',
    ]);

    const distShares = graph.rootShareByDeviceId.get('dist-a');
    expect(distShares?.get('core-1')).toBeCloseTo(0.5);
    expect(distShares?.get('core-2')).toBeCloseTo(0.5);

    const anchors = buildRelationRootAnchors(graph);
    expect(anchors.get('core-1')?.x).toBeCloseTo(-(anchors.get('core-2')?.x ?? 0));
    expect(anchors.get('core-1')?.z).toBeCloseTo(0);
    expect(anchors.get('core-2')?.z).toBeCloseTo(0);
    expect(Math.abs(anchors.get('core-1')?.x ?? 0)).toBeLessThan(5);
  });
});
