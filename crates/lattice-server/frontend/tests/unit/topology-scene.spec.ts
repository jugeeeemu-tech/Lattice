import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import type { ViewDevice, ViewLink } from '../../src/generated';
import { devicePlanarClearance, devicePlanarSupport } from '../../src/topology/device-visuals';
import {
  buildRelationLayoutGraph,
  buildRelationRootAnchors,
  buildNetworkLayoutClusters,
  computeNetworkLayoutTargets,
  computeClusterRequiredRadius,
  computeParallelLinkOffsets,
  placeClusterCenters,
  placeDevicesWithinCluster,
  recenterPositionsAroundRootCentroid,
  resolveParentFacingDevice,
} from '../../src/scene/topology-scene';
import type { TopologyStoreState } from '../../src/state/topology-store';

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

describe('network layout clusters', () => {
  function device(id: string, label: string, role: ViewDevice['device_role'] = 'server'): ViewDevice {
    return {
      id,
      label,
      depth: 0,
      deployment_type: 'unknown',
      device_role: role,
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

  it('splits same-cidr links into separate connected clusters', () => {
    const deviceById = new Map<string, ViewDevice>([
      ['r1', device('r1', 'r1', 'router')],
      ['s1', device('s1', 's1', 'switch')],
      ['r2', device('r2', 'r2', 'router')],
      ['s2', device('s2', 's2', 'switch')],
    ]);
    const clusters = buildNetworkLayoutClusters(
      [
        {
          id: 'a',
          local_device_id: 'r1',
          local_interface: 'eth0',
          protocol: 'lldp',
          network_cidrs: ['10.0.0.0/24'],
          remote_device_id: 's1',
          remote_interface: 'eth1',
        },
        {
          id: 'b',
          local_device_id: 'r2',
          local_interface: 'eth0',
          protocol: 'lldp',
          network_cidrs: ['10.0.0.0/24'],
          remote_device_id: 's2',
          remote_interface: 'eth1',
        },
      ],
      {
        depthByDeviceId: new Map([
          ['r1', 0],
          ['s1', 1],
          ['r2', 0],
          ['s2', 1],
        ]),
        deviceById,
        parentIdsByDeviceId: new Map([
          ['r1', []],
          ['s1', ['r1']],
          ['r2', []],
          ['s2', ['r2']],
        ]),
      }
    );

    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.networkCidr)).toEqual([
      '10.0.0.0/24',
      '10.0.0.0/24',
    ]);
    expect(clusters.map((cluster) => cluster.memberDeviceIds)).toEqual([
      ['r1', 's1'],
      ['r2', 's2'],
    ]);
  });

  it('tracks multi-cluster device weights from gray trunk links', () => {
    const deviceById = new Map<string, ViewDevice>([
      ['bridge', device('bridge', 'bridge', 'bridge')],
      ['router', device('router', 'router', 'router')],
      ['guest-a', device('guest-a', 'guest-a')],
      ['guest-b', device('guest-b', 'guest-b')],
    ]);
    const clusters = buildNetworkLayoutClusters(
      [
        {
          id: 'guest-a',
          local_device_id: 'bridge',
          local_interface: 'vmbr0',
          protocol: 'proxmox_guest_link',
          network_cidrs: ['10.10.20.0/24'],
          remote_device_id: 'guest-a',
          remote_interface: 'eth0',
        },
        {
          id: 'guest-b',
          local_device_id: 'bridge',
          local_interface: 'vmbr0',
          protocol: 'proxmox_guest_link',
          network_cidrs: ['10.10.30.0/24'],
          remote_device_id: 'guest-b',
          remote_interface: 'eth0',
        },
        {
          id: 'trunk',
          local_device_id: 'bridge',
          local_interface: 'vmbr0',
          protocol: 'proxmox_guest_link',
          network_cidrs: ['10.10.20.0/24', '10.10.30.0/24'],
          remote_device_id: 'router',
          remote_interface: 'net1',
        },
      ],
      {
        depthByDeviceId: new Map([
          ['bridge', 1],
          ['router', 0],
          ['guest-a', 2],
          ['guest-b', 2],
        ]),
        deviceById,
        parentIdsByDeviceId: new Map([
          ['router', []],
          ['bridge', ['router']],
          ['guest-a', ['bridge']],
          ['guest-b', ['bridge']],
        ]),
      }
    );

    expect(clusters).toHaveLength(2);
    const perClusterWeights = clusters.map(
      (cluster) => cluster.multiClusterDeviceWeights.get('router')?.get(cluster.clusterId) ?? 0
    );
    expect(perClusterWeights[0]).toBeCloseTo(0.5);
    expect(perClusterWeights[1]).toBeCloseTo(0.5);
  });

  it('resolves parent-facing device by depth then upstream reach', () => {
    const deviceById = new Map<string, ViewDevice>([
      ['a', device('a', 'agg-a', 'switch')],
      ['b', device('b', 'agg-b', 'switch')],
      ['root', device('root', 'root', 'router')],
    ]);
    const chosen = resolveParentFacingDevice(
      ['a', 'b'],
      new Map([
        ['a', 1],
        ['b', 1],
        ['root', 0],
      ]),
      [
        {
          id: 'root-a',
          local_device_id: 'root',
          local_interface: 'eth0',
          protocol: 'lldp',
          network_cidrs: ['10.0.0.0/24'],
          remote_device_id: 'a',
          remote_interface: 'eth1',
        },
      ],
      new Map([
        ['a', ['root']],
        ['b', []],
        ['root', []],
      ]),
      deviceById
    );

    expect(chosen).toBe('a');
  });

  it('computes required radius from the densest depth layer', () => {
    const clusterRadius = computeClusterRequiredRadius(
      {
        memberDepths: new Map([
          ['root', 0],
          ['leaf-1', 2],
          ['leaf-2', 2],
          ['leaf-3', 2],
          ['leaf-4', 2],
        ]),
        memberDeviceIds: ['root', 'leaf-1', 'leaf-2', 'leaf-3', 'leaf-4'],
        minDepth: 0,
      },
      new Map([
        ['root', device('root', 'root', 'router')],
        ['leaf-1', device('leaf-1', 'leaf-1')],
        ['leaf-2', device('leaf-2', 'leaf-2')],
        ['leaf-3', device('leaf-3', 'leaf-3')],
        ['leaf-4', device('leaf-4', 'leaf-4')],
      ]),
      new Map()
    );

    expect(clusterRadius).toBeGreaterThan(2.5);
  });

  it('fills inward with multiple rings for dense layers', () => {
    const cluster = {
      adjacentClusterIds: [],
      clusterId: 'cluster:test',
      memberDepths: new Map<string, number>(),
      memberDeviceIds: [] as string[],
      memberLinkIds: [],
      minDepth: 1,
      multiClusterDeviceWeights: new Map<string, Map<string, number>>(),
      networkCidr: '10.0.0.0/24',
      parentFacingDeviceId: 'device-0',
      requiredRadius: 5.6,
    };
    const deviceById = new Map<string, ViewDevice>();
    for (let index = 0; index < 12; index += 1) {
      const id = `device-${index}`;
      cluster.memberDeviceIds.push(id);
      cluster.memberDepths.set(id, 1);
      deviceById.set(id, device(id, id));
    }

    const positions = placeDevicesWithinCluster(cluster, new Vector3(0, 0, 0), 5.6, deviceById);
    const radii = Array.from(positions.values(), (position) => Math.hypot(position.x, position.z));
    const uniqueBands = new Set(radii.map((radius) => Math.round(radius * 10) / 10));
    expect(uniqueBands.size).toBeGreaterThan(1);
  });

  it('separates cluster centers to avoid overlap', () => {
    const deviceById = new Map<string, ViewDevice>([
      ['root-a', device('root-a', 'root-a', 'router')],
      ['dist-a', device('dist-a', 'dist-a', 'switch')],
      ['root-b', device('root-b', 'root-b', 'router')],
      ['dist-b', device('dist-b', 'dist-b', 'switch')],
    ]);
    const graph = buildRelationLayoutGraph(['root-a', 'dist-a', 'root-b', 'dist-b'], {
      childIdsByDeviceId: new Map([
        ['root-a', ['dist-a']],
        ['dist-a', []],
        ['root-b', ['dist-b']],
        ['dist-b', []],
      ]),
      deviceById,
      parentIdsByDeviceId: new Map([
        ['root-a', []],
        ['dist-a', ['root-a']],
        ['root-b', []],
        ['dist-b', ['root-b']],
      ]),
      peerIdsByDeviceId: new Map(),
      primaryChildrenByDeviceId: new Map(),
      primaryParentDeviceById: new Map(),
      rootDeviceIds: ['root-a', 'root-b'],
    });
    const clusters = buildNetworkLayoutClusters(
      [
        {
          id: 'link-a',
          local_device_id: 'root-a',
          local_interface: 'eth0',
          protocol: 'lldp',
          network_cidrs: ['10.0.0.0/24'],
          remote_device_id: 'dist-a',
          remote_interface: 'eth1',
        },
        {
          id: 'link-b',
          local_device_id: 'root-b',
          local_interface: 'eth0',
          protocol: 'lldp',
          network_cidrs: ['10.0.0.0/24'],
          remote_device_id: 'dist-b',
          remote_interface: 'eth1',
        },
      ],
      {
        depthByDeviceId: graph.depthByDeviceId,
        deviceById,
        parentIdsByDeviceId: graph.parentIdsByDeviceId,
      }
    );

    const centers = placeClusterCenters(clusters, graph, deviceById);
    const left = centers.get(clusters[0].clusterId);
    const right = centers.get(clusters[1].clusterId);
    expect(left && right).toBeTruthy();
    const distance = left?.distanceTo(right ?? new Vector3()) ?? 0;
    expect(distance).toBeGreaterThan(clusters[0].requiredRadius + clusters[1].requiredRadius);
  });

  it('keeps final device positions from overlapping in xz space', () => {
    const devices = [
      device('core', 'core', 'router'),
      device('bridge', 'bridge', 'bridge'),
      device('obs', 'obs01'),
      device('mc', 'mc01'),
      device('vyos', 'vyos01', 'router'),
      device('ct', 'tailscale-vpn'),
    ];
    const deviceById = new Map(devices.map((entry) => [entry.id, entry]));
    const links: ViewLink[] = [
      {
        id: 'core-bridge',
        local_device_id: 'core',
        local_interface: 'eth0',
        remote_device_id: 'bridge',
        remote_interface: 'vmbr0',
        protocol: 'lldp',
        network_cidrs: ['192.168.1.0/24'],
      },
      {
        id: 'bridge-obs',
        local_device_id: 'bridge',
        local_interface: 'vmbr0',
        remote_device_id: 'obs',
        remote_interface: 'eth0',
        protocol: 'proxmox_guest_link',
        network_cidrs: ['192.168.1.0/24'],
      },
      {
        id: 'bridge-mc',
        local_device_id: 'bridge',
        local_interface: 'vmbr0',
        remote_device_id: 'mc',
        remote_interface: 'eth0',
        protocol: 'proxmox_guest_link',
        network_cidrs: ['192.168.20.0/24'],
      },
      {
        id: 'bridge-vyos-trunk',
        local_device_id: 'bridge',
        local_interface: 'vmbr0',
        remote_device_id: 'vyos',
        remote_interface: 'net1',
        protocol: 'proxmox_guest_link',
        network_cidrs: ['192.168.20.0/24', '192.168.30.0/24'],
      },
      {
        id: 'bridge-ct',
        local_device_id: 'bridge',
        local_interface: 'vmbr0',
        remote_device_id: 'ct',
        remote_interface: 'eth0',
        protocol: 'proxmox_guest_link',
        network_cidrs: ['192.168.1.0/24'],
      },
    ];

    const state = {
      model: {
        childIdsByDeviceId: new Map([
          ['core', ['bridge']],
          ['bridge', ['obs', 'mc', 'vyos', 'ct']],
          ['obs', []],
          ['mc', []],
          ['vyos', []],
          ['ct', []],
        ]),
        deviceById,
        parentIdsByDeviceId: new Map([
          ['core', []],
          ['bridge', ['core']],
          ['obs', ['bridge']],
          ['mc', ['bridge']],
          ['vyos', ['bridge']],
          ['ct', ['bridge']],
        ]),
        peerIdsByDeviceId: new Map([
          ['core', []],
          ['bridge', []],
          ['obs', []],
          ['mc', []],
          ['vyos', []],
          ['ct', []],
        ]),
        primaryChildrenByDeviceId: new Map(),
        primaryParentDeviceById: new Map(),
        rootDeviceIds: ['core'],
        visibleLinkIds: new Set(links.map((link) => link.id)),
      },
      snapshot: {
        links,
      },
    } as unknown as TopologyStoreState;

    const positions = computeNetworkLayoutTargets(devices, state);
    const ids = devices.map((entry) => entry.id);

    for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
        const leftId = ids[leftIndex];
        const rightId = ids[rightIndex];
        const left = positions.get(leftId);
        const right = positions.get(rightId);
        expect(left && right).toBeTruthy();
        const dx = (right?.x ?? 0) - (left?.x ?? 0);
        const dy = (right?.y ?? 0) - (left?.y ?? 0);
        const dz = (right?.z ?? 0) - (left?.z ?? 0);
        const distance = Math.hypot(dx, dy, dz);
        const minDistance =
          devicePlanarSupport(deviceById.get(leftId) ?? devices[leftIndex], dx, dz) +
          devicePlanarSupport(deviceById.get(rightId) ?? devices[rightIndex], dx, dz) +
          devicePlanarClearance(deviceById.get(leftId) ?? devices[leftIndex]) +
          devicePlanarClearance(deviceById.get(rightId) ?? devices[rightIndex]) +
          0.12;
        expect(
          distance,
          `${leftId} vs ${rightId}: got ${distance}, expected >= ${minDistance - 0.02}`
        ).toBeGreaterThanOrEqual(minDistance - 0.02);
      }
    }
  });
});
