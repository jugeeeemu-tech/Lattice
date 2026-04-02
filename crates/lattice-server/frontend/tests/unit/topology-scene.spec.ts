import { describe, expect, it } from 'vitest';

import type { ViewLink } from '../../src/generated';
import { computeParallelLinkOffsets } from '../../src/scene/topology-scene';

describe('computeParallelLinkOffsets', () => {
  it('spreads same-pair links symmetrically and deterministically', () => {
    const links: ViewLink[] = [
      {
        id: 'link-b',
        local_device_id: 'device-a',
        local_interface: 'eth1',
        protocol: 'proxmox_guest_link',
        remote_device_id: 'device-b',
        remote_interface: 'eth2',
      },
      {
        id: 'link-a',
        local_device_id: 'device-a',
        local_interface: 'eth0',
        protocol: 'proxmox_guest_link',
        remote_device_id: 'device-b',
        remote_interface: 'eth1',
      },
      {
        id: 'link-c',
        local_device_id: 'device-b',
        local_interface: 'eth3',
        protocol: 'proxmox_guest_link',
        remote_device_id: 'device-a',
        remote_interface: 'eth4',
      },
      {
        id: 'link-other',
        local_device_id: 'device-a',
        local_interface: 'eth5',
        protocol: 'lldp',
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
