import type { ViewDevice, ViewLink } from '../../generated';
import {
  devicePlanarClearance,
  devicePlanarMaxDiameter,
} from '../../topology/device-visuals';
import { primaryNetworkCidr } from '../../topology/view-model';
import { compareDeviceIdsByLabel } from './layout-shared';

export interface NetworkLayoutCluster {
  adjacentClusterIds: string[];
  clusterId: string;
  memberDepths: Map<string, number>;
  memberDeviceIds: string[];
  memberLinkIds: string[];
  minDepth: number;
  multiClusterDeviceWeights: Map<string, Map<string, number>>;
  networkCidr: string;
  parentFacingDeviceId: string;
  requiredRadius: number;
}

interface NetworkClusterBuildInput {
  depthByDeviceId: Map<string, number>;
  deviceById: Map<string, ViewDevice>;
  parentIdsByDeviceId: Map<string, string[]>;
}

export function compareClusterIds(
  leftId: string,
  rightId: string,
  clustersById: Map<string, NetworkLayoutCluster>
): number {
  const left = clustersById.get(leftId);
  const right = clustersById.get(rightId);
  if (!left || !right) {
    return leftId.localeCompare(rightId);
  }
  return (
    left.minDepth - right.minDepth ||
    left.networkCidr.localeCompare(right.networkCidr) ||
    left.clusterId.localeCompare(right.clusterId)
  );
}

function networkClusterEdgeDeviceIds(link: ViewLink): [string, string] {
  return [link.local_device_id, link.remote_device_id];
}

function buildConnectedComponents(deviceIds: string[], adjacency: Map<string, Set<string>>): string[][] {
  const remaining = new Set(deviceIds);
  const components: string[][] = [];

  while (remaining.size > 0) {
    const start = remaining.values().next().value;
    if (!start) {
      break;
    }
    const queue = [start];
    const component: string[] = [];
    remaining.delete(start);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!remaining.has(neighbor)) {
          continue;
        }
        remaining.delete(neighbor);
        queue.push(neighbor);
      }
    }

    components.push(component);
  }

  return components;
}

export function resolveParentFacingDevice(
  deviceIds: string[],
  memberDepths: Map<string, number>,
  visibleLinks: ReadonlyArray<ViewLink>,
  parentIdsByDeviceId: Map<string, string[]>,
  deviceById: Map<string, ViewDevice>
): string {
  const sortedCandidates = [...deviceIds].sort(
    (leftId, rightId) =>
      compareDeviceIdsByLabel(leftId, rightId, deviceById) || leftId.localeCompare(rightId)
  );
  if (sortedCandidates.length === 0) {
    return '';
  }

  const minDepth = sortedCandidates.reduce(
    (minimum, deviceId) => Math.min(minimum, memberDepths.get(deviceId) ?? 0),
    Number.POSITIVE_INFINITY
  );
  const clusterMemberSet = new Set(deviceIds);
  const candidates = sortedCandidates.filter((deviceId) => (memberDepths.get(deviceId) ?? 0) === minDepth);
  let bestDeviceId = candidates[0];
  let bestScore = -1;

  for (const candidateId of candidates) {
    const candidateDepth = memberDepths.get(candidateId) ?? 0;
    const upstreamNeighbors = new Set<string>();

    for (const link of visibleLinks) {
      const [leftId, rightId] = networkClusterEdgeDeviceIds(link);
      const otherId = leftId === candidateId ? rightId : rightId === candidateId ? leftId : null;
      if (!otherId || clusterMemberSet.has(otherId)) {
        continue;
      }
      if ((memberDepths.get(otherId) ?? Number.POSITIVE_INFINITY) < candidateDepth) {
        upstreamNeighbors.add(otherId);
      }
    }

    for (const parentId of parentIdsByDeviceId.get(candidateId) ?? []) {
      if (
        !clusterMemberSet.has(parentId) &&
        (memberDepths.get(parentId) ?? Number.POSITIVE_INFINITY) < candidateDepth
      ) {
        upstreamNeighbors.add(parentId);
      }
    }

    if (
      upstreamNeighbors.size > bestScore ||
      (upstreamNeighbors.size === bestScore &&
        (compareDeviceIdsByLabel(candidateId, bestDeviceId, deviceById) < 0 ||
          (compareDeviceIdsByLabel(candidateId, bestDeviceId, deviceById) === 0 &&
            candidateId.localeCompare(bestDeviceId) < 0)))
    ) {
      bestScore = upstreamNeighbors.size;
      bestDeviceId = candidateId;
    }
  }

  return bestDeviceId;
}

export function computeClusterRequiredRadius(
  cluster: Pick<NetworkLayoutCluster, 'memberDepths' | 'memberDeviceIds' | 'minDepth'>,
  deviceById: Map<string, ViewDevice>,
  multiClusterWeightByDeviceId: Map<string, number>
): number {
  const layerDeviceIdsByDepth = new Map<number, string[]>();
  for (const deviceId of cluster.memberDeviceIds) {
    const depth = cluster.memberDepths.get(deviceId) ?? cluster.minDepth;
    const current = layerDeviceIdsByDepth.get(depth) ?? [];
    current.push(deviceId);
    layerDeviceIdsByDepth.set(depth, current);
  }

  let requiredRadius = 2.4;
  for (const [depth, layerDeviceIds] of layerDeviceIdsByDepth.entries()) {
    const totalDiameter = layerDeviceIds.reduce((sum, deviceId) => {
      const device = deviceById.get(deviceId);
      return sum + devicePlanarMaxDiameter(device) + devicePlanarClearance(device) * 2 + 0.42;
    }, 0);
    const circumferenceRadius = totalDiameter / (Math.PI * 2);
    const minLayerRadius = layerDeviceIds.length <= 1 ? 0 : 1.9;
    const bridgePenalty = layerDeviceIds.reduce(
      (sum, deviceId) => sum + (multiClusterWeightByDeviceId.get(deviceId) ?? 0) * 0.45,
      0
    );
    const depthPadding = Math.max(0, depth - cluster.minDepth) * 0.35;
    requiredRadius = Math.max(
      requiredRadius,
      Math.max(minLayerRadius, circumferenceRadius) + bridgePenalty + depthPadding
    );
  }

  return requiredRadius;
}

export function buildNetworkLayoutClusters(
  visibleLinks: ReadonlyArray<ViewLink>,
  input: NetworkClusterBuildInput
): NetworkLayoutCluster[] {
  const coloredLinksByCidr = new Map<string, ViewLink[]>();
  for (const link of visibleLinks) {
    const networkCidr = primaryNetworkCidr(link);
    if (!networkCidr) {
      continue;
    }
    const current = coloredLinksByCidr.get(networkCidr) ?? [];
    current.push(link);
    coloredLinksByCidr.set(networkCidr, current);
  }

  const clusters: NetworkLayoutCluster[] = [];
  const clustersById = new Map<string, NetworkLayoutCluster>();
  const clusterIdsByDeviceId = new Map<string, string[]>();
  const clusterIdsByDeviceAndCidr = new Map<string, Map<string, string[]>>();
  const multiWeightByDeviceId = new Map<string, number>();

  for (const [networkCidr, links] of coloredLinksByCidr.entries()) {
    const adjacency = new Map<string, Set<string>>();
    const deviceIds = new Set<string>();
    for (const link of links) {
      const [leftId, rightId] = networkClusterEdgeDeviceIds(link);
      deviceIds.add(leftId);
      deviceIds.add(rightId);
      const leftNeighbors = adjacency.get(leftId) ?? new Set<string>();
      leftNeighbors.add(rightId);
      adjacency.set(leftId, leftNeighbors);
      const rightNeighbors = adjacency.get(rightId) ?? new Set<string>();
      rightNeighbors.add(leftId);
      adjacency.set(rightId, rightNeighbors);
    }

    const components = buildConnectedComponents(Array.from(deviceIds), adjacency);
    components.forEach((componentDeviceIds, componentIndex) => {
      const componentSet = new Set(componentDeviceIds);
      const componentLinks = links
        .filter((link) => {
          const [leftId, rightId] = networkClusterEdgeDeviceIds(link);
          return componentSet.has(leftId) && componentSet.has(rightId);
        })
        .map((link) => link.id)
        .sort();
      const memberDepths = new Map(
        componentDeviceIds.map((deviceId) => [deviceId, input.depthByDeviceId.get(deviceId) ?? 0])
      );
      const memberDeviceIds = [...componentDeviceIds].sort((leftId, rightId) =>
        compareDeviceIdsByLabel(leftId, rightId, input.deviceById)
      );
      const minDepth = memberDeviceIds.reduce(
        (minimum, deviceId) => Math.min(minimum, memberDepths.get(deviceId) ?? 0),
        Number.POSITIVE_INFINITY
      );
      const clusterId = `cluster:${networkCidr}:${componentIndex}`;
      const cluster: NetworkLayoutCluster = {
        adjacentClusterIds: [],
        clusterId,
        memberDepths,
        memberDeviceIds,
        memberLinkIds: componentLinks,
        minDepth: Number.isFinite(minDepth) ? minDepth : 0,
        multiClusterDeviceWeights: new Map(),
        networkCidr,
        parentFacingDeviceId: '',
        requiredRadius: 0,
      };
      clusters.push(cluster);
      clustersById.set(clusterId, cluster);

      for (const deviceId of memberDeviceIds) {
        const currentClusterIds = clusterIdsByDeviceId.get(deviceId) ?? [];
        currentClusterIds.push(clusterId);
        clusterIdsByDeviceId.set(deviceId, currentClusterIds);
        const cidrMap = clusterIdsByDeviceAndCidr.get(deviceId) ?? new Map<string, string[]>();
        const perCidrClusterIds = cidrMap.get(networkCidr) ?? [];
        perCidrClusterIds.push(clusterId);
        cidrMap.set(networkCidr, perCidrClusterIds);
        clusterIdsByDeviceAndCidr.set(deviceId, cidrMap);
      }
    });
  }

  const adjacencyByClusterId = new Map<string, Set<string>>(
    clusters.map((cluster) => [cluster.clusterId, new Set<string>()])
  );
  for (const deviceClusterIds of clusterIdsByDeviceId.values()) {
    for (let leftIndex = 0; leftIndex < deviceClusterIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < deviceClusterIds.length; rightIndex += 1) {
        adjacencyByClusterId.get(deviceClusterIds[leftIndex])?.add(deviceClusterIds[rightIndex]);
        adjacencyByClusterId.get(deviceClusterIds[rightIndex])?.add(deviceClusterIds[leftIndex]);
      }
    }
  }

  for (const link of visibleLinks) {
    if (link.network_cidrs.length <= 1) {
      continue;
    }
    const perCidrWeight = 1 / link.network_cidrs.length;
    const endpointIds = [link.local_device_id, link.remote_device_id];
    for (const endpointId of endpointIds) {
      for (const networkCidr of link.network_cidrs) {
        const directMatches = clusterIdsByDeviceAndCidr.get(endpointId)?.get(networkCidr) ?? [];
        const remoteEndpointId = endpointIds[0] === endpointId ? endpointIds[1] : endpointIds[0];
        const fallbackMatches = clusterIdsByDeviceAndCidr.get(remoteEndpointId)?.get(networkCidr) ?? [];
        const matchedClusterIds = (directMatches.length > 0 ? directMatches : fallbackMatches).slice().sort();
        if (matchedClusterIds.length === 0) {
          continue;
        }

        multiWeightByDeviceId.set(endpointId, (multiWeightByDeviceId.get(endpointId) ?? 0) + perCidrWeight);
        const distributedWeight = perCidrWeight / matchedClusterIds.length;
        for (const clusterId of matchedClusterIds) {
          const cluster = clustersById.get(clusterId);
          if (!cluster) {
            continue;
          }
          const clusterWeightByClusterId =
            cluster.multiClusterDeviceWeights.get(endpointId) ?? new Map<string, number>();
          clusterWeightByClusterId.set(
            clusterId,
            (clusterWeightByClusterId.get(clusterId) ?? 0) + distributedWeight
          );
          cluster.multiClusterDeviceWeights.set(endpointId, clusterWeightByClusterId);

          for (const siblingClusterId of matchedClusterIds) {
            if (siblingClusterId === clusterId) {
              continue;
            }
            adjacencyByClusterId.get(clusterId)?.add(siblingClusterId);
          }
        }
      }
    }
  }

  for (const cluster of clusters) {
    cluster.parentFacingDeviceId = resolveParentFacingDevice(
      cluster.memberDeviceIds,
      cluster.memberDepths,
      visibleLinks,
      input.parentIdsByDeviceId,
      input.deviceById
    );
    cluster.requiredRadius = computeClusterRequiredRadius(cluster, input.deviceById, multiWeightByDeviceId);
    cluster.adjacentClusterIds = Array.from(adjacencyByClusterId.get(cluster.clusterId) ?? []).sort(
      (leftId, rightId) => compareClusterIds(leftId, rightId, clustersById)
    );
  }

  return clusters.sort(
    (left, right) =>
      left.minDepth - right.minDepth ||
      left.networkCidr.localeCompare(right.networkCidr) ||
      left.clusterId.localeCompare(right.clusterId)
  );
}
