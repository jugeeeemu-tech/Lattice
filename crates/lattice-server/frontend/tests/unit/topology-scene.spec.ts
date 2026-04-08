import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import type { ViewDevice, ViewLink } from '../../src/generated';
import {
  buildRelationLayoutGraph,
  buildRelationRootAnchors,
  buildNetworkLayoutClusters,
  computeClusterRequiredRadius,
  computeParallelLinkOffsets,
  placeClusterCenters,
  placeDevicesWithinCluster,
  recenterPositionsAroundRootCentroid,
  resolveParentFacingDevice,
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

  it('spreads root-direct clusters across an area instead of collapsing them onto one line', () => {
    const deviceById = new Map<string, ViewDevice>([
      ['root-a', device('root-a', 'root-a-router')],
      ['root-b', device('root-b', 'root-b-router')],
      ['branch-a1', device('branch-a1', 'branch-a1-router')],
      ['branch-a2', device('branch-a2', 'branch-a2-router')],
      ['branch-b1', device('branch-b1', 'branch-b1-router')],
      ['branch-b2', device('branch-b2', 'branch-b2-router')],
    ]);
    const graph = buildRelationLayoutGraph(
      ['root-a', 'root-b', 'branch-a1', 'branch-a2', 'branch-b1', 'branch-b2'],
      {
        childIdsByDeviceId: new Map([
          ['root-a', ['branch-a1', 'branch-a2']],
          ['root-b', ['branch-b1', 'branch-b2']],
          ['branch-a1', []],
          ['branch-a2', []],
          ['branch-b1', []],
          ['branch-b2', []],
        ]),
        deviceById,
        parentIdsByDeviceId: new Map([
          ['root-a', []],
          ['root-b', []],
          ['branch-a1', ['root-a']],
          ['branch-a2', ['root-a']],
          ['branch-b1', ['root-b']],
          ['branch-b2', ['root-b']],
        ]),
        peerIdsByDeviceId: new Map(),
        primaryChildrenByDeviceId: new Map(),
        primaryParentDeviceById: new Map(),
        rootDeviceIds: ['root-a', 'root-b'],
      }
    );
    const clusters = buildNetworkLayoutClusters(
      [
        {
          id: 'root-a-branch-a1',
          local_device_id: 'root-a',
          local_interface: 'eth0',
          protocol: 'lldp',
          network_cidrs: ['10.0.0.0/30'],
          remote_device_id: 'branch-a1',
          remote_interface: 'eth0',
        },
        {
          id: 'root-a-branch-a2',
          local_device_id: 'root-a',
          local_interface: 'eth1',
          protocol: 'lldp',
          network_cidrs: ['10.0.0.4/30'],
          remote_device_id: 'branch-a2',
          remote_interface: 'eth0',
        },
        {
          id: 'root-b-branch-b1',
          local_device_id: 'root-b',
          local_interface: 'eth0',
          protocol: 'lldp',
          network_cidrs: ['10.0.0.8/30'],
          remote_device_id: 'branch-b1',
          remote_interface: 'eth0',
        },
        {
          id: 'root-b-branch-b2',
          local_device_id: 'root-b',
          local_interface: 'eth1',
          protocol: 'lldp',
          network_cidrs: ['10.0.0.12/30'],
          remote_device_id: 'branch-b2',
          remote_interface: 'eth0',
        },
      ],
      {
        depthByDeviceId: graph.depthByDeviceId,
        deviceById,
        parentIdsByDeviceId: graph.parentIdsByDeviceId,
      }
    );

    const centers = placeClusterCenters(clusters, graph, deviceById);
    const zValues = clusters
      .map((cluster) => centers.get(cluster.clusterId)?.z ?? 0)
      .sort((left, right) => left - right);

    expect(Math.abs(zValues[0])).toBeGreaterThan(0.5);
    expect(Math.abs(zValues[zValues.length - 1])).toBeGreaterThan(0.5);
    expect(zValues[zValues.length - 1] - zValues[0]).toBeGreaterThan(2);
  });

  it('places sibling child clusters within a forward fan instead of opposite directions', () => {
    const deviceById = new Map<string, ViewDevice>([
      ['hub', device('hub', 'hub-router', 'router')],
      ['branch', device('branch', 'branch-router', 'router')],
      ['sw-a', device('sw-a', 'branch-switch-a', 'switch')],
      ['sw-b', device('sw-b', 'branch-switch-b', 'switch')],
    ]);
    const graph = buildRelationLayoutGraph(['hub', 'branch', 'sw-a', 'sw-b'], {
      childIdsByDeviceId: new Map([
        ['hub', ['branch']],
        ['branch', ['sw-a', 'sw-b']],
        ['sw-a', []],
        ['sw-b', []],
      ]),
      deviceById,
      parentIdsByDeviceId: new Map([
        ['hub', []],
        ['branch', ['hub']],
        ['sw-a', ['branch']],
        ['sw-b', ['branch']],
      ]),
      peerIdsByDeviceId: new Map(),
      primaryChildrenByDeviceId: new Map(),
      primaryParentDeviceById: new Map(),
      rootDeviceIds: ['hub'],
    });
    const clusters = buildNetworkLayoutClusters(
      [
        {
          id: 'hub-branch',
          local_device_id: 'hub',
          local_interface: 'eth0',
          protocol: 'lldp',
          network_cidrs: ['10.0.0.0/24'],
          remote_device_id: 'branch',
          remote_interface: 'eth0',
        },
        {
          id: 'branch-sw-a',
          local_device_id: 'branch',
          local_interface: 'eth1',
          protocol: 'lldp',
          network_cidrs: ['10.0.1.0/24'],
          remote_device_id: 'sw-a',
          remote_interface: 'eth0',
        },
        {
          id: 'branch-sw-b',
          local_device_id: 'branch',
          local_interface: 'eth2',
          protocol: 'lldp',
          network_cidrs: ['10.0.2.0/24'],
          remote_device_id: 'sw-b',
          remote_interface: 'eth0',
        },
      ],
      {
        depthByDeviceId: graph.depthByDeviceId,
        deviceById,
        parentIdsByDeviceId: graph.parentIdsByDeviceId,
      }
    );

    const centers = placeClusterCenters(clusters, graph, deviceById);
    const parentCluster = clusters.find((cluster) => cluster.networkCidr === '10.0.0.0/24');
    const childClusterA = clusters.find((cluster) => cluster.networkCidr === '10.0.1.0/24');
    const childClusterB = clusters.find((cluster) => cluster.networkCidr === '10.0.2.0/24');
    expect(parentCluster && childClusterA && childClusterB).toBeTruthy();

    const parentCenter = centers.get(parentCluster?.clusterId ?? '');
    const childCenterA = centers.get(childClusterA?.clusterId ?? '');
    const childCenterB = centers.get(childClusterB?.clusterId ?? '');
    expect(parentCenter && childCenterA && childCenterB).toBeTruthy();

    const childVectorA = new Vector3(
      (childCenterA?.x ?? 0) - (parentCenter?.x ?? 0),
      0,
      (childCenterA?.z ?? 0) - (parentCenter?.z ?? 0)
    ).normalize();
    const childVectorB = new Vector3(
      (childCenterB?.x ?? 0) - (parentCenter?.x ?? 0),
      0,
      (childCenterB?.z ?? 0) - (parentCenter?.z ?? 0)
    ).normalize();

    expect(childVectorA.dot(childVectorB)).toBeGreaterThan(0);
  });

  it('keeps each branch subtree grouped when neighboring branches also reserve descendant space', () => {
    const deviceById = new Map<string, ViewDevice>([
      ['hub', device('hub', 'hub-router', 'router')],
      ['branch-a', device('branch-a', 'branch-router-a', 'router')],
      ['branch-b', device('branch-b', 'branch-router-b', 'router')],
      ['sw-a1', device('sw-a1', 'branch-switch-a1', 'switch')],
      ['sw-a2', device('sw-a2', 'branch-switch-a2', 'switch')],
      ['sw-b1', device('sw-b1', 'branch-switch-b1', 'switch')],
      ['sw-b2', device('sw-b2', 'branch-switch-b2', 'switch')],
    ]);
    const graph = buildRelationLayoutGraph(
      ['hub', 'branch-a', 'branch-b', 'sw-a1', 'sw-a2', 'sw-b1', 'sw-b2'],
      {
        childIdsByDeviceId: new Map([
          ['hub', ['branch-a', 'branch-b']],
          ['branch-a', ['sw-a1', 'sw-a2']],
          ['branch-b', ['sw-b1', 'sw-b2']],
          ['sw-a1', []],
          ['sw-a2', []],
          ['sw-b1', []],
          ['sw-b2', []],
        ]),
        deviceById,
        parentIdsByDeviceId: new Map([
          ['hub', []],
          ['branch-a', ['hub']],
          ['branch-b', ['hub']],
          ['sw-a1', ['branch-a']],
          ['sw-a2', ['branch-a']],
          ['sw-b1', ['branch-b']],
          ['sw-b2', ['branch-b']],
        ]),
        peerIdsByDeviceId: new Map(),
        primaryChildrenByDeviceId: new Map(),
        primaryParentDeviceById: new Map(),
        rootDeviceIds: ['hub'],
      }
    );
    const links: ViewLink[] = [
      {
        id: 'hub-branch-a',
        local_device_id: 'hub',
        local_interface: 'eth0',
        protocol: 'lldp',
        network_cidrs: ['10.0.0.0/24'],
        remote_device_id: 'branch-a',
        remote_interface: 'eth0',
      },
      {
        id: 'hub-branch-b',
        local_device_id: 'hub',
        local_interface: 'eth1',
        protocol: 'lldp',
        network_cidrs: ['10.0.1.0/24'],
        remote_device_id: 'branch-b',
        remote_interface: 'eth0',
      },
      {
        id: 'branch-a-sw-a1',
        local_device_id: 'branch-a',
        local_interface: 'eth1',
        protocol: 'lldp',
        network_cidrs: ['10.1.0.0/24'],
        remote_device_id: 'sw-a1',
        remote_interface: 'eth0',
      },
      {
        id: 'branch-a-sw-a2',
        local_device_id: 'branch-a',
        local_interface: 'eth2',
        protocol: 'lldp',
        network_cidrs: ['10.2.0.0/24'],
        remote_device_id: 'sw-a2',
        remote_interface: 'eth0',
      },
      {
        id: 'branch-b-sw-b1',
        local_device_id: 'branch-b',
        local_interface: 'eth1',
        protocol: 'lldp',
        network_cidrs: ['10.3.0.0/24'],
        remote_device_id: 'sw-b1',
        remote_interface: 'eth0',
      },
      {
        id: 'branch-b-sw-b2',
        local_device_id: 'branch-b',
        local_interface: 'eth2',
        protocol: 'lldp',
        network_cidrs: ['10.4.0.0/24'],
        remote_device_id: 'sw-b2',
        remote_interface: 'eth0',
      },
    ];
    const clusters = buildNetworkLayoutClusters(links, {
      depthByDeviceId: graph.depthByDeviceId,
      deviceById,
      parentIdsByDeviceId: graph.parentIdsByDeviceId,
    });

    const centers = placeClusterCenters(clusters, graph, deviceById);
    const clusterByCidr = new Map(clusters.map((cluster) => [cluster.networkCidr, cluster]));

    const groupedDot = (parentCidr: string, leftCidr: string, rightCidr: string) => {
      const parentCenter = centers.get(clusterByCidr.get(parentCidr)?.clusterId ?? '') ?? new Vector3();
      const leftCenter = centers.get(clusterByCidr.get(leftCidr)?.clusterId ?? '') ?? new Vector3();
      const rightCenter = centers.get(clusterByCidr.get(rightCidr)?.clusterId ?? '') ?? new Vector3();
      return new Vector3(leftCenter.x - parentCenter.x, 0, leftCenter.z - parentCenter.z)
        .normalize()
        .dot(new Vector3(rightCenter.x - parentCenter.x, 0, rightCenter.z - parentCenter.z).normalize());
    };

    expect(groupedDot('10.0.0.0/24', '10.1.0.0/24', '10.2.0.0/24')).toBeGreaterThan(0);
    expect(groupedDot('10.0.1.0/24', '10.3.0.0/24', '10.4.0.0/24')).toBeGreaterThan(0);
  });
});
