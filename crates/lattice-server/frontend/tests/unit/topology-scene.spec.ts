import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import type { ViewLink } from '../../src/generated';
import {
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
