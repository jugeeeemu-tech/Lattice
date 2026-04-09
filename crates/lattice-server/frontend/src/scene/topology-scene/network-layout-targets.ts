import { Vector3 } from 'three';

import type { ViewDevice } from '../../generated';
import type { TopologyStoreState } from '../../state/topology-store';
import {
  devicePlanarClearance,
  devicePlanarMaxDiameter,
  devicePlanarSupport,
} from '../../topology/device-visuals';
import { clampMagnitude, compareDeviceIdsByLabel, hash01, pairKey } from './layout-shared';
import {
  buildRelationLayoutGraph,
  buildRelationRootAnchors,
  recenterPositionsAroundRootCentroid,
  type RelationLayoutGraph,
} from './relation-layout';
import {
  buildNetworkLayoutClusters,
  compareClusterIds,
  type NetworkLayoutCluster,
} from './network-clusters';

interface ClusterLayoutPlacement {
  angularAllowance: number;
  center: Vector3;
  cluster: NetworkLayoutCluster;
  initialCenter: Vector3;
  parentClusterId: string | null;
  preferredAngle: number | null;
  preferredDistance: number | null;
  preferredElevation: number | null;
  reservedRadius: number;
}

function clusterRootAnchor(
  cluster: NetworkLayoutCluster,
  rootAnchors: Map<string, Vector3>,
  rootSharesByDeviceId: Map<string, Map<string, number>>
): Vector3 {
  const center = new Vector3();
  let totalWeight = 0;
  for (const deviceId of cluster.memberDeviceIds) {
    const rootShares = rootSharesByDeviceId.get(deviceId) ?? new Map();
    for (const [rootId, share] of rootShares.entries()) {
      const anchor = rootAnchors.get(rootId);
      if (!anchor) {
        continue;
      }
      center.add(anchor.clone().multiplyScalar(share));
      totalWeight += share;
    }
  }
  if (totalWeight > 0) {
    center.divideScalar(totalWeight);
  }
  return center;
}

function clusterRootWeights(
  cluster: NetworkLayoutCluster,
  rootSharesByDeviceId: Map<string, Map<string, number>>
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const deviceId of cluster.memberDeviceIds) {
    for (const [rootId, share] of rootSharesByDeviceId.get(deviceId) ?? []) {
      weights.set(rootId, (weights.get(rootId) ?? 0) + share);
    }
  }
  return weights;
}

function rootForwardAxis(rootId: string, rootAnchor: Vector3, rootAnchors: Map<string, Vector3>): Vector3 {
  const anchorList = Array.from(rootAnchors.values());
  if (anchorList.length <= 1) {
    return new Vector3(0, 0, 1);
  }

  const centroid = new Vector3();
  for (const anchor of anchorList) {
    centroid.add(anchor);
  }
  centroid.divideScalar(anchorList.length);

  if (anchorList.length === 2) {
    const otherAnchor = anchorList.find((candidate) => !candidate.equals(rootAnchor)) ?? anchorList[0];
    const axis = otherAnchor.clone().sub(rootAnchor);
    if (axis.lengthSq() < 0.0001) {
      return new Vector3(0, 0, 1);
    }
    axis.normalize();
    return new Vector3(-axis.z, 0, axis.x).normalize();
  }

  const outward = rootAnchor.clone().sub(centroid);
  if (outward.lengthSq() < 0.0001) {
    const fallbackAngle = hash01(`root-forward:${rootId}`) * Math.PI * 2;
    return new Vector3(Math.cos(fallbackAngle), 0, Math.sin(fallbackAngle));
  }
  return outward.normalize();
}

function computeParentChildClusterDistance(
  parentCluster: NetworkLayoutCluster,
  childReservedRadius: number,
  childMinDepth: number
): number {
  const depthDelta = Math.max(0, childMinDepth - parentCluster.minDepth);
  const dynamicClearance = Math.max(
    0.9,
    Math.min(2.6, parentCluster.requiredRadius * 0.18 + childReservedRadius * 0.12 + depthDelta * 0.35)
  );
  return parentCluster.requiredRadius + childReservedRadius + dynamicClearance;
}

function computeClusterLateralReservation(
  cluster: Pick<NetworkLayoutCluster, 'requiredRadius'>,
  reservedRadius: number
): number {
  const subtreeReach = Math.max(cluster.requiredRadius, reservedRadius);
  return Math.max(cluster.requiredRadius, Math.sqrt(cluster.requiredRadius * subtreeReach));
}

function computeSiblingSphereSlots(
  siblingLateralRadii: number[],
  baseSphereRadius: number,
  siblingGap: number,
  seedKey: string
): {
  sphereRadius: number;
  slots: Array<{ offsetX: number; offsetZ: number; verticalOffset: number; angularAllowance: number }>;
  usedRadius: number;
} {
  if (siblingLateralRadii.length === 0) {
    return { sphereRadius: 0, usedRadius: 0, slots: [] };
  }

  let sphereRadius = Math.max(1.1, baseSphereRadius);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  let slots: Array<{
    angularAllowance: number;
    offsetX: number;
    offsetZ: number;
    verticalOffset: number;
  }> = [];

  for (let attempt = 0; attempt < 10; attempt += 1) {
    slots = siblingLateralRadii.map((lateralRadius, index) => {
      const usableRadius = Math.max(0, sphereRadius - lateralRadius - 0.2);
      const normalizedRadius =
        siblingLateralRadii.length === 1 ? 0 : Math.sqrt((index + 0.5) / siblingLateralRadii.length);
      const radius = usableRadius * normalizedRadius;
      const phase = hash01(`${seedKey}:sphere:${index}`) * Math.PI * 2;
      return {
        angularAllowance: Math.max(
          0.3,
          Math.asin(
            Math.min(0.98, (lateralRadius + siblingGap) / Math.max(0.0001, sphereRadius + lateralRadius))
          ) * 2
        ),
        offsetX: Math.cos(goldenAngle * index + phase) * radius,
        offsetZ: Math.sin(goldenAngle * index + phase) * radius,
        verticalOffset: 0,
      };
    });

    for (let iteration = 0; iteration < 32; iteration += 1) {
      for (let leftIndex = 0; leftIndex < slots.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < slots.length; rightIndex += 1) {
          const left = slots[leftIndex];
          const right = slots[rightIndex];
          let dx = right.offsetX - left.offsetX;
          let dz = right.offsetZ - left.offsetZ;
          let distance = Math.hypot(dx, dz);
          if (distance < 0.0001) {
            const angle = hash01(`sibling-overlap:${seedKey}:${leftIndex}:${rightIndex}`) * Math.PI * 2;
            dx = Math.cos(angle) * 0.001;
            dz = Math.sin(angle) * 0.001;
            distance = 0.001;
          }

          const minDistance = siblingLateralRadii[leftIndex] + siblingLateralRadii[rightIndex] + siblingGap;
          if (distance >= minDistance) {
            continue;
          }

          const delta = (minDistance - distance) * 0.45;
          const unitX = dx / distance;
          const unitZ = dz / distance;
          left.offsetX -= unitX * delta;
          left.offsetZ -= unitZ * delta;
          right.offsetX += unitX * delta;
          right.offsetZ += unitZ * delta;
        }
      }

      for (let index = 0; index < slots.length; index += 1) {
        const slot = slots[index];
        const limit = Math.max(0, sphereRadius - siblingLateralRadii[index] - 0.1);
        const distance = Math.hypot(slot.offsetX, slot.offsetZ);
        if (distance > limit && distance > 0.0001) {
          const scale = limit / distance;
          slot.offsetX *= scale;
          slot.offsetZ *= scale;
        }
      }
    }

    let maxOverflow = 0;
    for (let leftIndex = 0; leftIndex < slots.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < slots.length; rightIndex += 1) {
        const minDistance = siblingLateralRadii[leftIndex] + siblingLateralRadii[rightIndex] + siblingGap;
        const distance = Math.hypot(
          slots[rightIndex].offsetX - slots[leftIndex].offsetX,
          slots[rightIndex].offsetZ - slots[leftIndex].offsetZ
        );
        maxOverflow = Math.max(maxOverflow, minDistance - distance);
      }
    }
    for (let index = 0; index < slots.length; index += 1) {
      const limit = Math.max(0, sphereRadius - siblingLateralRadii[index] - 0.1);
      maxOverflow = Math.max(maxOverflow, Math.hypot(slots[index].offsetX, slots[index].offsetZ) - limit);
    }

    if (maxOverflow <= 0.12) {
      break;
    }
    sphereRadius += maxOverflow * 0.75 + 0.35;
  }

  const usedRadius =
    slots.reduce(
      (maximum, slot, index) =>
        Math.max(maximum, Math.hypot(slot.offsetX, slot.offsetZ) + siblingLateralRadii[index]),
      0
    ) || sphereRadius;

  return { sphereRadius, usedRadius, slots };
}

function layoutRootClustersInRootRegions(
  rootClusters: ReadonlyArray<NetworkLayoutCluster>,
  rootAnchors: Map<string, Vector3>,
  rootSharesByDeviceId: Map<string, Map<string, number>>,
  reservedRadiusByClusterId: Map<string, number>
): Map<string, Vector3> {
  const placements = new Map<string, Vector3>();
  if (rootClusters.length === 0) {
    return placements;
  }

  const entries = rootClusters.map((cluster) => {
    const weights = clusterRootWeights(cluster, rootSharesByDeviceId);
    let dominantRootId: string | null = null;
    let dominantWeight = -1;
    let totalWeight = 0;
    const weightedAnchor = new Vector3();
    for (const [rootId, weight] of weights.entries()) {
      totalWeight += weight;
      const anchor = rootAnchors.get(rootId);
      if (anchor) {
        weightedAnchor.add(anchor.clone().multiplyScalar(weight));
      }
      if (weight > dominantWeight) {
        dominantWeight = weight;
        dominantRootId = rootId;
      }
    }
    if (totalWeight > 0) {
      weightedAnchor.divideScalar(totalWeight);
    }

    return {
      cluster,
      dominantRootId,
      lateralRadius: computeClusterLateralReservation(
        cluster,
        reservedRadiusByClusterId.get(cluster.clusterId) ?? cluster.requiredRadius
      ),
      reservedRadius: reservedRadiusByClusterId.get(cluster.clusterId) ?? cluster.requiredRadius,
      weightedAnchor,
    };
  });

  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const rootId = entry.dominantRootId ?? rootAnchors.keys().next().value ?? null;
    if (!rootId) {
      continue;
    }
    const group = groups.get(rootId) ?? [];
    group.push(entry);
    groups.set(rootId, group);
  }

  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (const [rootId, groupEntries] of groups.entries()) {
    const rootAnchor = rootAnchors.get(rootId);
    if (!rootAnchor) {
      continue;
    }

    groupEntries.sort(
      (left, right) =>
        right.reservedRadius - left.reservedRadius ||
        left.cluster.networkCidr.localeCompare(right.cluster.networkCidr) ||
        left.cluster.clusterId.localeCompare(right.cluster.clusterId)
    );

    const forwardAxis = rootForwardAxis(rootId, rootAnchor, rootAnchors);
    const lateralAxis = new Vector3(-forwardAxis.z, 0, forwardAxis.x);
    const maxLateralRadius = groupEntries.reduce((maximum, entry) => Math.max(maximum, entry.lateralRadius), 0);
    const areaDemand = groupEntries.reduce(
      (sum, entry) => sum + Math.PI * Math.pow(entry.lateralRadius + 0.4, 2),
      0
    );
    let diskRadius = Math.max(maxLateralRadius + 0.5, Math.sqrt(areaDemand / Math.PI));
    let localOffsets: Array<{ entry: (typeof groupEntries)[number]; x: number; z: number }> = [];
    const placementGap = 0.9;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      localOffsets = groupEntries.map((entry, index) => {
        const usableRadius = Math.max(0, diskRadius - entry.lateralRadius - 0.2);
        const normalizedRadius =
          groupEntries.length === 1 ? 0 : Math.sqrt((index + 0.5) / groupEntries.length);
        const radius = usableRadius * normalizedRadius;
        const phase = hash01(`${rootId}:${entry.cluster.clusterId}:root-region`) * Math.PI * 2;
        return {
          entry,
          x: Math.cos(goldenAngle * index + phase) * radius,
          z: Math.sin(goldenAngle * index + phase) * radius,
        };
      });

      for (let iteration = 0; iteration < 36; iteration += 1) {
        for (let leftIndex = 0; leftIndex < localOffsets.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < localOffsets.length; rightIndex += 1) {
            const left = localOffsets[leftIndex];
            const right = localOffsets[rightIndex];
            let dx = right.x - left.x;
            let dz = right.z - left.z;
            let distance = Math.hypot(dx, dz);
            if (distance < 0.0001) {
              const angle =
                hash01(`root-region-overlap:${left.entry.cluster.clusterId}:${right.entry.cluster.clusterId}`) *
                Math.PI *
                2;
              dx = Math.cos(angle) * 0.001;
              dz = Math.sin(angle) * 0.001;
              distance = 0.001;
            }

            const minDistance = left.entry.lateralRadius + right.entry.lateralRadius + placementGap;
            if (distance >= minDistance) {
              continue;
            }

            const delta = (minDistance - distance) * 0.45;
            const unitX = dx / distance;
            const unitZ = dz / distance;
            left.x -= unitX * delta;
            left.z -= unitZ * delta;
            right.x += unitX * delta;
            right.z += unitZ * delta;
          }
        }

        for (const local of localOffsets) {
          const limit = Math.max(0, diskRadius - local.entry.lateralRadius - 0.1);
          const distance = Math.hypot(local.x, local.z);
          if (distance > limit && distance > 0.0001) {
            const scale = limit / distance;
            local.x *= scale;
            local.z *= scale;
          }
        }
      }

      let maxOverflow = 0;
      for (let leftIndex = 0; leftIndex < localOffsets.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < localOffsets.length; rightIndex += 1) {
          const left = localOffsets[leftIndex];
          const right = localOffsets[rightIndex];
          const minDistance = left.entry.lateralRadius + right.entry.lateralRadius + placementGap;
          const distance = Math.hypot(right.x - left.x, right.z - left.z);
          maxOverflow = Math.max(maxOverflow, minDistance - distance);
        }
      }
      for (const local of localOffsets) {
        const limit = Math.max(0, diskRadius - local.entry.lateralRadius - 0.1);
        maxOverflow = Math.max(maxOverflow, Math.hypot(local.x, local.z) - limit);
      }

      if (maxOverflow <= 0.12) {
        break;
      }
      diskRadius += maxOverflow * 0.75 + 0.5;
    }

    const rootClearance =
      groupEntries.reduce((maximum, entry) => Math.max(maximum, entry.cluster.requiredRadius), 0) + 0.8;
    const usedRadius =
      localOffsets.reduce(
        (maximum, local) => Math.max(maximum, Math.hypot(local.x, local.z) + local.entry.lateralRadius),
        0
      ) || maxLateralRadius;
    const diskCenter = rootAnchor.clone().add(forwardAxis.clone().multiplyScalar(usedRadius + rootClearance));

    for (const local of localOffsets) {
      const center = diskCenter
        .clone()
        .add(lateralAxis.clone().multiplyScalar(local.x))
        .add(forwardAxis.clone().multiplyScalar(local.z));
      placements.set(local.entry.cluster.clusterId, center);
    }
  }

  return placements;
}

function relaxRootClusterCenters(placements: ClusterLayoutPlacement[]): void {
  if (placements.length <= 1) {
    return;
  }

  for (let iteration = 0; iteration < 12; iteration += 1) {
    for (let leftIndex = 0; leftIndex < placements.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < placements.length; rightIndex += 1) {
        const left = placements[leftIndex];
        const right = placements[rightIndex];
        let dx = right.center.x - left.center.x;
        let dz = right.center.z - left.center.z;
        let distance = Math.hypot(dx, dz);
        if (distance < 0.0001) {
          const angle = hash01(`root-cluster-overlap:${left.cluster.clusterId}:${right.cluster.clusterId}`) * Math.PI * 2;
          dx = Math.cos(angle) * 0.001;
          dz = Math.sin(angle) * 0.001;
          distance = 0.001;
        }

        const minDistance = left.reservedRadius + right.reservedRadius + 2.2;
        if (distance >= minDistance) {
          continue;
        }

        const delta = (minDistance - distance) * 0.45;
        const unitX = dx / distance;
        const unitZ = dz / distance;
        left.center.x -= unitX * delta;
        left.center.z -= unitZ * delta;
        right.center.x += unitX * delta;
        right.center.z += unitZ * delta;
      }
    }

    for (const placement of placements) {
      placement.center.lerp(placement.initialCenter, 0.08);
    }
  }
}

function normalizeAngleDelta(angle: number): number {
  let normalized = angle;
  while (normalized > Math.PI) {
    normalized -= Math.PI * 2;
  }
  while (normalized < -Math.PI) {
    normalized += Math.PI * 2;
  }
  return normalized;
}

function computeSubtreeReservedRadii(
  clustersById: Map<string, NetworkLayoutCluster>,
  childClusterIdsByParentId: Map<string, string[]>
): Map<string, number> {
  const reservedRadiusByClusterId = new Map<string, number>();

  const visit = (clusterId: string): number => {
    const cached = reservedRadiusByClusterId.get(clusterId);
    if (cached !== undefined) {
      return cached;
    }

    const cluster = clustersById.get(clusterId);
    if (!cluster) {
      return 0;
    }

    let reservedRadius = cluster.requiredRadius;
    for (const childClusterId of childClusterIdsByParentId.get(clusterId) ?? []) {
      const childCluster = clustersById.get(childClusterId);
      if (!childCluster) {
        continue;
      }
      const childReservedRadius = visit(childClusterId);
      const childDistance = computeParentChildClusterDistance(
        cluster,
        childReservedRadius,
        childCluster.minDepth
      );
      reservedRadius = Math.max(reservedRadius, childDistance + childReservedRadius);
    }

    reservedRadiusByClusterId.set(clusterId, reservedRadius);
    return reservedRadius;
  };

  for (const clusterId of clustersById.keys()) {
    visit(clusterId);
  }

  return reservedRadiusByClusterId;
}

export function placeClusterCenters(
  clusters: ReadonlyArray<NetworkLayoutCluster>,
  graph: RelationLayoutGraph,
  deviceById: Map<string, ViewDevice>
): Map<string, Vector3> {
  const rootAnchors = buildRelationRootAnchors(graph);
  const clustersById = new Map(clusters.map((cluster) => [cluster.clusterId, cluster]));
  const parentClusterIdByClusterId = new Map<string, string>();
  const childClusterIdsByParentId = new Map<string, string[]>();
  const adjacencyScoreByPair = new Map<string, number>();

  for (const cluster of clusters) {
    for (const adjacentClusterId of cluster.adjacentClusterIds) {
      const scoreKey = pairKey(cluster.clusterId, adjacentClusterId);
      adjacencyScoreByPair.set(scoreKey, (adjacencyScoreByPair.get(scoreKey) ?? 0) + 1);
    }
  }

  for (const cluster of clusters) {
    const candidateParents = cluster.adjacentClusterIds
      .map((clusterId) => clustersById.get(clusterId))
      .filter((candidate): candidate is NetworkLayoutCluster => Boolean(candidate))
      .filter((candidate) => candidate.minDepth < cluster.minDepth);

    if (candidateParents.length === 0) {
      continue;
    }

    candidateParents.sort((left, right) => {
      const leftScore = adjacencyScoreByPair.get(pairKey(cluster.clusterId, left.clusterId)) ?? 0;
      const rightScore = adjacencyScoreByPair.get(pairKey(cluster.clusterId, right.clusterId)) ?? 0;
      return (
        rightScore - leftScore ||
        left.minDepth - right.minDepth ||
        compareDeviceIdsByLabel(left.parentFacingDeviceId, right.parentFacingDeviceId, deviceById) ||
        left.clusterId.localeCompare(right.clusterId)
      );
    });

    parentClusterIdByClusterId.set(cluster.clusterId, candidateParents[0].clusterId);
    const currentChildren = childClusterIdsByParentId.get(candidateParents[0].clusterId) ?? [];
    currentChildren.push(cluster.clusterId);
    childClusterIdsByParentId.set(candidateParents[0].clusterId, currentChildren);
  }

  const placeWithReservedRadii = (
    reservedRadiusByClusterId: Map<string, number>
  ): Map<string, Vector3> => {
    const localPlacements = new Map<string, ClusterLayoutPlacement>();
    const rootClusters = clusters.filter((cluster) => !parentClusterIdByClusterId.has(cluster.clusterId));
    const rootClusterCenters = layoutRootClustersInRootRegions(
      rootClusters,
      rootAnchors,
      graph.rootShareByDeviceId,
      reservedRadiusByClusterId
    );
    for (const rootCluster of rootClusters) {
      const initialCenter =
        rootClusterCenters.get(rootCluster.clusterId) ??
        clusterRootAnchor(rootCluster, rootAnchors, graph.rootShareByDeviceId);
      localPlacements.set(rootCluster.clusterId, {
        angularAllowance: Math.PI,
        center: initialCenter.clone(),
        cluster: rootCluster,
        initialCenter,
        parentClusterId: null,
        preferredAngle: null,
        preferredDistance: null,
        preferredElevation: null,
        reservedRadius: reservedRadiusByClusterId.get(rootCluster.clusterId) ?? rootCluster.requiredRadius,
      });
    }
    const rootPlacementList = rootClusters
      .map((cluster) => localPlacements.get(cluster.clusterId))
      .filter((placement): placement is ClusterLayoutPlacement => Boolean(placement));
    relaxRootClusterCenters(rootPlacementList);
    const rootCentroid = new Vector3();
    for (const placement of rootPlacementList) {
      rootCentroid.add(placement.center);
    }
    if (rootPlacementList.length > 0) {
      rootCentroid.divideScalar(rootPlacementList.length);
    }
    const sortedRootPlacements = [...rootPlacementList].sort(
      (left, right) =>
        left.center.x - right.center.x ||
        left.center.z - right.center.z ||
        left.cluster.clusterId.localeCompare(right.cluster.clusterId)
    );
    const rootAxisVector =
      sortedRootPlacements.length >= 2
        ? sortedRootPlacements[sortedRootPlacements.length - 1].center
            .clone()
            .sub(sortedRootPlacements[0].center)
        : new Vector3(1, 0, 0);
    if (rootAxisVector.lengthSq() < 0.0001) {
      rootAxisVector.set(1, 0, 0);
    }
    rootAxisVector.normalize();
    const rootNormalAngle = Math.atan2(rootAxisVector.x, -rootAxisVector.z);
    const maxRootProjection =
      rootPlacementList.reduce((maximum, placement) => {
        const offset = placement.center.clone().sub(rootCentroid);
        const projection = offset.x * rootAxisVector.x + offset.z * rootAxisVector.z;
        return Math.max(maximum, Math.abs(projection));
      }, 0) || 1;

    const sortedClusters = [...clusters].sort(
      (left, right) =>
        left.minDepth - right.minDepth ||
        compareDeviceIdsByLabel(left.parentFacingDeviceId, right.parentFacingDeviceId, deviceById) ||
        left.clusterId.localeCompare(right.clusterId)
    );
    for (const cluster of sortedClusters) {
      if (localPlacements.has(cluster.clusterId)) {
        continue;
      }
      const parentClusterId = parentClusterIdByClusterId.get(cluster.clusterId);
      const parentPlacement = parentClusterId ? localPlacements.get(parentClusterId) : null;
      if (!parentClusterId || !parentPlacement) {
        const initialCenter = clusterRootAnchor(cluster, rootAnchors, graph.rootShareByDeviceId);
        localPlacements.set(cluster.clusterId, {
          angularAllowance: Math.PI,
          center: initialCenter.clone(),
          cluster,
          initialCenter,
          parentClusterId: null,
          preferredAngle: null,
          preferredDistance: null,
          preferredElevation: null,
          reservedRadius: reservedRadiusByClusterId.get(cluster.clusterId) ?? cluster.requiredRadius,
        });
        continue;
      }

      const siblingClusterIds = (childClusterIdsByParentId.get(parentClusterId) ?? []).sort((leftId, rightId) =>
        compareClusterIds(leftId, rightId, clustersById)
      );
      const siblingIndex = siblingClusterIds.indexOf(cluster.clusterId);
      const grandparentClusterId = parentClusterIdByClusterId.get(parentClusterId);
      const grandparentPlacement = grandparentClusterId ? localPlacements.get(grandparentClusterId) : null;
      let baseAngle = hash01(`cluster-parent:${parentClusterId}`) * Math.PI * 2;
      let baseElevation = 0;
      if (grandparentPlacement) {
        baseAngle = Math.atan2(
          parentPlacement.center.z - grandparentPlacement.center.z,
          parentPlacement.center.x - grandparentPlacement.center.x
        );
      } else if (parentPlacement.parentClusterId === null) {
        baseAngle = rootNormalAngle;
        const rootOffset = parentPlacement.center.clone().sub(rootCentroid);
        const rootProjection =
          rootOffset.x * rootAxisVector.x + rootOffset.z * rootAxisVector.z;
        baseElevation = (rootProjection / maxRootProjection) * 0.22;
      } else if (Math.hypot(parentPlacement.center.x, parentPlacement.center.z) > 0.0001) {
        baseAngle = Math.atan2(parentPlacement.center.z, parentPlacement.center.x);
      }
      const reservedRadius = reservedRadiusByClusterId.get(cluster.clusterId) ?? cluster.requiredRadius;
      const siblingGap = 0.9;
      const siblingLateralRadii = siblingClusterIds.map((siblingClusterId) => {
        const siblingCluster = clustersById.get(siblingClusterId);
        return siblingCluster
          ? computeClusterLateralReservation(
              siblingCluster,
              reservedRadiusByClusterId.get(siblingClusterId) ?? siblingCluster.requiredRadius
            )
          : 0;
      });
      const isRootDirectChild = parentPlacement.parentClusterId === null;
      const baseSphereRadius = Math.max(
        siblingLateralRadii.reduce((sum, radius) => sum + Math.PI * Math.pow(radius + siblingGap * 0.5, 2), 0) > 0
          ? Math.sqrt(
              siblingLateralRadii.reduce(
                (sum, radius) => sum + Math.PI * Math.pow(radius + siblingGap * 0.5, 2),
                0
              ) / Math.PI
            )
          : 0,
        Math.max(
          ...siblingLateralRadii,
          computeClusterLateralReservation(cluster, reservedRadius)
        ) + (isRootDirectChild ? 0.4 : 0.3)
      );
      const siblingLayout = computeSiblingSphereSlots(
        siblingLateralRadii,
        baseSphereRadius,
        siblingGap,
        parentClusterId
      );
      const slot = siblingLayout.slots[siblingIndex] ?? {
        angularAllowance: Math.PI / 6,
        offsetX: 0,
        offsetZ: 0,
        verticalOffset: 0,
      };
      const forwardAxis = new Vector3(Math.cos(baseAngle), 0, Math.sin(baseAngle));
      const sphereCenterDistance =
        parentPlacement.cluster.requiredRadius + siblingLayout.usedRadius + (isRootDirectChild ? 0.9 : 0.45);
      const sphereCenter = new Vector3(
        parentPlacement.center.x + forwardAxis.x * sphereCenterDistance,
        parentPlacement.center.y + baseElevation * sphereCenterDistance * 0.35,
        parentPlacement.center.z + forwardAxis.z * sphereCenterDistance
      );
      const lateralAxis = new Vector3(-Math.sin(baseAngle), 0, Math.cos(baseAngle));
      const xzOffset = lateralAxis
        .clone()
        .multiplyScalar(slot.offsetX)
        .add(forwardAxis.clone().multiplyScalar(slot.offsetZ));
      const initialCenter = new Vector3(
        sphereCenter.x + xzOffset.x,
        sphereCenter.y + slot.verticalOffset,
        sphereCenter.z + xzOffset.z
      );
      localPlacements.set(cluster.clusterId, {
        angularAllowance: slot.angularAllowance,
        center: initialCenter.clone(),
        cluster,
        initialCenter,
        parentClusterId,
        preferredAngle: baseAngle,
        preferredDistance: sphereCenterDistance,
        preferredElevation: baseElevation,
        reservedRadius,
      });
    }

    return new Map(
      Array.from(localPlacements.values()).map((placement) => [placement.cluster.clusterId, placement.center.clone()])
    );
  };

  const estimatedReservedRadiusByClusterId = computeSubtreeReservedRadii(
    clustersById,
    childClusterIdsByParentId
  );
  return placeWithReservedRadii(estimatedReservedRadiusByClusterId);
}

function placeDevicesOnRings(
  deviceIds: string[],
  center: Vector3,
  layerRadius: number,
  targetY: number,
  seedKey: string,
  deviceById: Map<string, ViewDevice>
): Map<string, Vector3> {
  const positions = new Map<string, Vector3>();
  if (deviceIds.length === 0) {
    return positions;
  }
  if (deviceIds.length === 1) {
    positions.set(deviceIds[0], new Vector3(center.x, targetY, center.z));
    return positions;
  }

  const sortedDeviceIds = [...deviceIds].sort((leftId, rightId) =>
    compareDeviceIdsByLabel(leftId, rightId, deviceById)
  );
  const maxFootprint = sortedDeviceIds.reduce(
    (maximum, deviceId) =>
      Math.max(
        maximum,
        devicePlanarMaxDiameter(deviceById.get(deviceId)) +
          devicePlanarClearance(deviceById.get(deviceId)) * 2 +
          0.3
      ),
    1.8
  );
  const ringSpacing = Math.max(2.8, maxFootprint * 2.05);
  const slotSpacing = Math.max(2.9, maxFootprint * 2.35);
  let cursor = 0;
  let ringIndex = 0;

  while (cursor < sortedDeviceIds.length) {
    const radius = Math.max(0, layerRadius - ringIndex * ringSpacing);
    const remaining = sortedDeviceIds.length - cursor;
    if (radius < slotSpacing * 0.75 || remaining === 1) {
      const deviceId = sortedDeviceIds[cursor];
      const angle = hash01(`${seedKey}:center:${deviceId}`) * Math.PI * 2;
      const centerOffset = Math.min(radius, slotSpacing * 0.35);
      positions.set(
        deviceId,
        new Vector3(
          center.x + Math.cos(angle) * centerOffset,
          targetY,
          center.z + Math.sin(angle) * centerOffset
        )
      );
      cursor += 1;
      continue;
    }

    const circumference = Math.PI * 2 * Math.max(radius, slotSpacing);
    const capacity = Math.max(4, Math.floor(circumference / slotSpacing));
    const ringDeviceIds = sortedDeviceIds.slice(cursor, cursor + Math.min(remaining, capacity));
    const startAngle = hash01(`${seedKey}:ring:${ringIndex}`) * Math.PI * 2;
    const angleStep = (Math.PI * 2) / ringDeviceIds.length;
    ringDeviceIds.forEach((deviceId, deviceIndex) => {
      const angle = startAngle + angleStep * deviceIndex;
      positions.set(
        deviceId,
        new Vector3(
          center.x + Math.cos(angle) * radius,
          targetY,
          center.z + Math.sin(angle) * radius
        )
      );
    });
    cursor += ringDeviceIds.length;
    ringIndex += 1;
  }

  return positions;
}

export function placeDevicesWithinCluster(
  cluster: NetworkLayoutCluster,
  center: Vector3,
  depthSpacing: number,
  deviceById: Map<string, ViewDevice>
): Map<string, Vector3> {
  const positions = new Map<string, Vector3>();
  const deviceIdsByDepth = new Map<number, string[]>();
  for (const deviceId of cluster.memberDeviceIds) {
    const depth = cluster.memberDepths.get(deviceId) ?? cluster.minDepth;
    const current = deviceIdsByDepth.get(depth) ?? [];
    current.push(deviceId);
    deviceIdsByDepth.set(depth, current);
  }

  const sortedDepths = Array.from(deviceIdsByDepth.keys()).sort((left, right) => left - right);
  for (const depth of sortedDepths) {
    const layerDeviceIds = deviceIdsByDepth.get(depth) ?? [];
    const multiClusterBonus = layerDeviceIds.reduce((sum, deviceId) => {
      const weightSum = Array.from(cluster.multiClusterDeviceWeights.get(deviceId)?.values() ?? []).reduce(
        (innerSum, weight) => innerSum + weight,
        0
      );
      return sum + weightSum * 0.45;
    }, 0);
    const layerRadius = Math.min(
      cluster.requiredRadius + Math.max(0, depth - cluster.minDepth) * 0.35,
      cluster.requiredRadius + multiClusterBonus
    );
    const baseDepthY = -depth * depthSpacing;
    const layerCenter = new Vector3(center.x, center.y + baseDepthY, center.z);
    const layerPositions = placeDevicesOnRings(
      layerDeviceIds,
      layerCenter,
      Math.max(0, layerRadius),
      layerCenter.y,
      `${cluster.clusterId}:depth:${depth}`,
      deviceById
    );
    for (const [deviceId, position] of layerPositions.entries()) {
      positions.set(deviceId, position);
    }
  }

  return positions;
}

function computeLegacyRelationTargets(
  devices: ViewDevice[],
  state: TopologyStoreState
): Map<string, Vector3> {
  const visibleIds = new Set(devices.map((device) => device.id));
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const layoutGraph = buildRelationLayoutGraph(visibleIds, {
    childIdsByDeviceId: state.model.childIdsByDeviceId,
    deviceById: state.model.deviceById,
    parentIdsByDeviceId: state.model.parentIdsByDeviceId,
    peerIdsByDeviceId: state.model.peerIdsByDeviceId,
    primaryChildrenByDeviceId: state.model.primaryChildrenByDeviceId,
    primaryParentDeviceById: state.model.primaryParentDeviceById,
    rootDeviceIds: state.model.rootDeviceIds,
  });
  const childrenByDeviceId = layoutGraph.childIdsByDeviceId;
  const parentsByDeviceId = layoutGraph.parentIdsByDeviceId;
  const roots = layoutGraph.rootDeviceIds;
  const rootSet = new Set(roots);

  const depthSpacing = 5.6;
  const slotSpacing = 2.8;
  const groupRingStart = 1.7;
  const groupRingStep = 1.7;
  const relaxIterations = 10;
  const maxStep = 0.22;
  const anchorByDeviceId = new Map<string, Vector3>();

  const placeConcentricGroup = (
    deviceIds: string[],
    center: Vector3,
    targetY: number,
    seedKey: string,
    innerRadius: number,
    radiusStep: number
  ) => {
    let cursor = 0;
    let ringIndex = 0;

    while (cursor < deviceIds.length) {
      const baseRadius = innerRadius + ringIndex * radiusStep;
      const capacity = Math.max(6, Math.floor((Math.PI * 2 * baseRadius) / slotSpacing));
      const ringIds = deviceIds.slice(cursor, cursor + capacity);
      const startAngle = hash01(`${seedKey}:ring:${ringIndex}`) * Math.PI * 2;
      const angleStep = ringIds.length > 0 ? (Math.PI * 2) / ringIds.length : 0;

      for (let index = 0; index < ringIds.length; index += 1) {
        const deviceId = ringIds[index];
        const childIds = childrenByDeviceId.get(deviceId) ?? [];
        const radius = baseRadius + (childIds.length > 0 ? 0.55 : 0);
        const angle = startAngle + index * angleStep;
        anchorByDeviceId.set(
          deviceId,
          new Vector3(
            center.x + Math.cos(angle) * radius,
            targetY,
            center.z + Math.sin(angle) * radius
          )
        );
      }

      cursor += ringIds.length;
      ringIndex += 1;
    }
  };
  const rootAnchors = buildRelationRootAnchors(layoutGraph);
  for (const [deviceId, anchor] of rootAnchors.entries()) {
    anchorByDeviceId.set(deviceId, anchor.clone());
  }

  const devicesByDepth = new Map<number, string[]>();
  for (const [deviceId, depth] of layoutGraph.depthByDeviceId.entries()) {
    if (depth <= 0) {
      continue;
    }
    const current = devicesByDepth.get(depth) ?? [];
    current.push(deviceId);
    devicesByDepth.set(depth, current);
  }

  const sortedDepths = Array.from(devicesByDepth.keys()).sort((left, right) => left - right);
  for (const depth of sortedDepths) {
    const layerIds = devicesByDepth.get(depth) ?? [];
    const groups = new Map<string, { center: Vector3; deviceIds: string[] }>();

    for (const deviceId of layerIds) {
      const parentIds = parentsByDeviceId.get(deviceId) ?? [];
      const parentAnchors = parentIds
        .map((parentId) => anchorByDeviceId.get(parentId))
        .filter((anchor): anchor is Vector3 => Boolean(anchor));

      const rootShares = layoutGraph.rootShareByDeviceId.get(deviceId) ?? new Map();
      const weightedRootCenter = new Vector3();
      let weightedTotal = 0;
      for (const [rootId, share] of rootShares.entries()) {
        const rootAnchor = rootAnchors.get(rootId);
        if (!rootAnchor) {
          continue;
        }
        weightedRootCenter.add(rootAnchor.clone().multiplyScalar(share));
        weightedTotal += share;
      }
      if (weightedTotal > 0) {
        weightedRootCenter.divideScalar(weightedTotal);
      }

      const parentCenter = new Vector3();
      if (parentAnchors.length > 0) {
        for (const anchor of parentAnchors) {
          parentCenter.add(anchor);
        }
        parentCenter.divideScalar(parentAnchors.length);
      } else {
        parentCenter.copy(weightedRootCenter);
      }

      const center =
        weightedTotal > 0 && parentAnchors.length > 0
          ? parentCenter.clone().lerp(weightedRootCenter, 0.25)
          : parentCenter.clone();
      center.y = -depth * depthSpacing;

      const signatureParts = [
        `depth:${depth}`,
        `parents:${parentIds.join('|')}`,
        `roots:${Array.from(rootShares.keys()).sort().join('|')}`,
      ];
      const signature = signatureParts.join('::');
      const group = groups.get(signature) ?? { center: new Vector3(), deviceIds: [] };
      group.center.add(center);
      group.deviceIds.push(deviceId);
      groups.set(signature, group);
    }

    const sortedGroups = Array.from(groups.entries()).sort(([leftKey], [rightKey]) =>
      leftKey.localeCompare(rightKey)
    );
    for (const [signature, group] of sortedGroups) {
      group.center.divideScalar(Math.max(group.deviceIds.length, 1));
      group.deviceIds.sort((leftId, rightId) =>
        compareDeviceIdsByLabel(leftId, rightId, deviceById)
      );

      if (group.deviceIds.length === 1) {
        anchorByDeviceId.set(group.deviceIds[0], group.center.clone());
        continue;
      }

      placeConcentricGroup(
        group.deviceIds,
        group.center,
        group.center.y,
        signature,
        groupRingStart,
        groupRingStep
      );
    }
  }

  const orderedIds = devices.map((device) => device.id).sort((leftId, rightId) => leftId.localeCompare(rightId));
  const positions = new Map(
    Array.from(anchorByDeviceId.entries(), ([deviceId, anchor]) => [deviceId, anchor.clone()])
  );

  for (let iteration = 0; iteration < relaxIterations; iteration += 1) {
    const forces = new Map(orderedIds.map((deviceId) => [deviceId, { x: 0, z: 0 }]));

    for (let leftIndex = 0; leftIndex < orderedIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < orderedIds.length; rightIndex += 1) {
        const leftId = orderedIds[leftIndex];
        const rightId = orderedIds[rightIndex];
        const leftPosition = positions.get(leftId);
        const rightPosition = positions.get(rightId);
        if (!leftPosition || !rightPosition) {
          continue;
        }

        let dx = rightPosition.x - leftPosition.x;
        let dz = rightPosition.z - leftPosition.z;
        let distance = Math.hypot(dx, dz);
        if (distance < 0.0001) {
          const angle = hash01(`layout:${pairKey(leftId, rightId)}`) * Math.PI * 2;
          dx = Math.cos(angle) * 0.001;
          dz = Math.sin(angle) * 0.001;
          distance = 0.001;
        }

        const minDistance =
          devicePlanarSupport(deviceById.get(leftId), dx, dz) +
          devicePlanarSupport(deviceById.get(rightId), dx, dz) +
          devicePlanarClearance(deviceById.get(leftId)) +
          devicePlanarClearance(deviceById.get(rightId)) +
          0.06;
        if (distance >= minDistance) {
          continue;
        }

        const normalized = (minDistance - distance) / minDistance;
        const strength = 0.18 * normalized;
        const unitX = dx / distance;
        const unitZ = dz / distance;
        const leftForce = forces.get(leftId);
        const rightForce = forces.get(rightId);
        if (!leftForce || !rightForce) {
          continue;
        }
        leftForce.x -= unitX * strength;
        leftForce.z -= unitZ * strength;
        rightForce.x += unitX * strength;
        rightForce.z += unitZ * strength;
      }
    }

    for (const deviceId of orderedIds) {
      const anchor = anchorByDeviceId.get(deviceId);
      const position = positions.get(deviceId);
      const force = forces.get(deviceId);
      if (!anchor || !position || !force) {
        continue;
      }
      const anchorStrength = rootSet.has(deviceId) ? 0.24 : 0.18;
      force.x += (anchor.x - position.x) * anchorStrength;
      force.z += (anchor.z - position.z) * anchorStrength;
    }

    for (const deviceId of orderedIds) {
      const position = positions.get(deviceId);
      const force = forces.get(deviceId);
      if (!position || !force) {
        continue;
      }
      position.x += clampMagnitude(force.x, maxStep);
      position.z += clampMagnitude(force.z, maxStep);
    }
  }

  recenterPositionsAroundRootCentroid(positions, roots);

  return new Map(
    Array.from(positions.entries(), ([deviceId, position]) => {
      const anchor = anchorByDeviceId.get(deviceId) ?? position;
      return [deviceId, new Vector3(position.x, anchor.y, position.z)];
    })
  );
}

export function computeNetworkLayoutTargets(
  devices: ViewDevice[],
  state: TopologyStoreState
): Map<string, Vector3> {
  if (devices.length === 0) {
    return new Map();
  }

  const legacyTargets = computeLegacyRelationTargets(devices, state);
  const visibleIds = new Set(devices.map((device) => device.id));
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const visibleLinks = state.snapshot.links.filter(
    (link) =>
      state.model.visibleLinkIds.has(link.id) &&
      visibleIds.has(link.local_device_id) &&
      visibleIds.has(link.remote_device_id)
  );
  const layoutGraph = buildRelationLayoutGraph(visibleIds, {
    childIdsByDeviceId: state.model.childIdsByDeviceId,
    deviceById: state.model.deviceById,
    parentIdsByDeviceId: state.model.parentIdsByDeviceId,
    peerIdsByDeviceId: state.model.peerIdsByDeviceId,
    primaryChildrenByDeviceId: state.model.primaryChildrenByDeviceId,
    primaryParentDeviceById: state.model.primaryParentDeviceById,
    rootDeviceIds: state.model.rootDeviceIds,
  });
  const parentsByDeviceId = layoutGraph.parentIdsByDeviceId;
  const roots = layoutGraph.rootDeviceIds;
  const rootSet = new Set(roots);
  const depthSpacing = 5.6;
  const clusters = buildNetworkLayoutClusters(visibleLinks, {
    depthByDeviceId: layoutGraph.depthByDeviceId,
    deviceById,
    parentIdsByDeviceId: parentsByDeviceId,
  });
  if (clusters.length === 0) {
    return legacyTargets;
  }

  const clusterCentersById = placeClusterCenters(clusters, layoutGraph, deviceById);
  const proposalEntriesByDeviceId = new Map<string, Array<{ position: Vector3; weight: number }>>();

  for (const cluster of clusters) {
    const clusterCenter = clusterCentersById.get(cluster.clusterId);
    if (!clusterCenter) {
      continue;
    }

    const clusterPositions = placeDevicesWithinCluster(cluster, clusterCenter, depthSpacing, deviceById);
    for (const [deviceId, position] of clusterPositions.entries()) {
      const current = proposalEntriesByDeviceId.get(deviceId) ?? [];
      current.push({ position, weight: 1 });
      proposalEntriesByDeviceId.set(deviceId, current);
    }

    for (const [deviceId, clusterWeights] of cluster.multiClusterDeviceWeights.entries()) {
      if (cluster.memberDeviceIds.includes(deviceId)) {
        continue;
      }
      const weight = clusterWeights.get(cluster.clusterId) ?? 0;
      if (weight <= 0) {
        continue;
      }
      const depth = layoutGraph.depthByDeviceId.get(deviceId) ?? 0;
      const seedAngle = hash01(`${cluster.clusterId}:bridge:${deviceId}`) * Math.PI * 2;
      const bridgeRadius = Math.max(
        cluster.requiredRadius + devicePlanarMaxDiameter(deviceById.get(deviceId)) * 0.35,
        1.8
      );
      const bridgePosition = new Vector3(
        clusterCenter.x + Math.cos(seedAngle) * bridgeRadius,
        -depth * depthSpacing,
        clusterCenter.z + Math.sin(seedAngle) * bridgeRadius
      );
      const current = proposalEntriesByDeviceId.get(deviceId) ?? [];
      current.push({ position: bridgePosition, weight });
      proposalEntriesByDeviceId.set(deviceId, current);
    }
  }

  const anchorByDeviceId = new Map<string, Vector3>(legacyTargets);
  const sameClusterDepthMinDistanceByPair = new Map<string, number>();
  const sameClusterDepthProtectedDeviceIds = new Set<string>();
  for (const device of devices) {
    const proposals = proposalEntriesByDeviceId.get(device.id) ?? [];
    if (proposals.length === 0) {
      if (!anchorByDeviceId.has(device.id)) {
        const depth = layoutGraph.depthByDeviceId.get(device.id) ?? 0;
        anchorByDeviceId.set(device.id, new Vector3(0, -depth * depthSpacing, 0));
      }
      continue;
    }

    const combined = new Vector3();
    let totalWeight = 0;
    for (const proposal of proposals) {
      combined.add(proposal.position.clone().multiplyScalar(proposal.weight));
      totalWeight += proposal.weight;
    }
    if (totalWeight > 0) {
      combined.divideScalar(totalWeight);
    }

    const fallback = legacyTargets.get(device.id);
    const depth = layoutGraph.depthByDeviceId.get(device.id) ?? 0;
    const defaultDepthY = -depth * depthSpacing;
    const blended = fallback
      ? fallback.clone().multiplyScalar(0.15).add(combined.multiplyScalar(0.85))
      : combined;
    blended.y = defaultDepthY;
    anchorByDeviceId.set(device.id, blended);
  }

  for (const cluster of clusters) {
    const clusterCenter = clusterCentersById.get(cluster.clusterId);
    if (!clusterCenter) {
      continue;
    }
    const clusterPositions = placeDevicesWithinCluster(cluster, clusterCenter, depthSpacing, deviceById);
    const deviceIdsByDepth = new Map<number, string[]>();
    for (const deviceId of cluster.memberDeviceIds) {
      const depth = cluster.memberDepths.get(deviceId) ?? cluster.minDepth;
      const current = deviceIdsByDepth.get(depth) ?? [];
      current.push(deviceId);
      deviceIdsByDepth.set(depth, current);
    }

    for (const layerDeviceIds of deviceIdsByDepth.values()) {
      if (layerDeviceIds.length <= 1) {
        continue;
      }
      const sortedLayerDeviceIds = [...layerDeviceIds].sort((leftId, rightId) =>
        compareDeviceIdsByLabel(leftId, rightId, deviceById)
      );
      for (let leftIndex = 0; leftIndex < sortedLayerDeviceIds.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < sortedLayerDeviceIds.length; rightIndex += 1) {
          const leftId = sortedLayerDeviceIds[leftIndex];
          const rightId = sortedLayerDeviceIds[rightIndex];
          const leftPosition = clusterPositions.get(leftId);
          const rightPosition = clusterPositions.get(rightId);
          if (!leftPosition || !rightPosition) {
            continue;
          }

          const initialDistance = leftPosition.distanceTo(rightPosition);
          const pair = pairKey(leftId, rightId);
          const protectedDistance = initialDistance * 0.94;
          const currentProtectedDistance = sameClusterDepthMinDistanceByPair.get(pair) ?? 0;
          sameClusterDepthMinDistanceByPair.set(pair, Math.max(currentProtectedDistance, protectedDistance));
          sameClusterDepthProtectedDeviceIds.add(leftId);
          sameClusterDepthProtectedDeviceIds.add(rightId);
        }
      }
    }
  }

  const redundantGroupIdByDeviceId = new Map<string, string>();
  const redundantTargetAnchorByDeviceId = new Map<string, Vector3>();
  const redundantMinDistanceByPair = new Map<string, number>();
  const redundantGroupsByKey = new Map<string, string[]>();
  for (const device of devices) {
    const childIds = (layoutGraph.childIdsByDeviceId.get(device.id) ?? [])
      .filter((childId) => visibleIds.has(childId))
      .sort((leftId, rightId) => leftId.localeCompare(rightId));
    if (childIds.length === 0) {
      continue;
    }
    const groupKey = childIds.join('|');
    const group = redundantGroupsByKey.get(groupKey) ?? [];
    group.push(device.id);
    redundantGroupsByKey.set(groupKey, group);
  }

  for (const [groupKey, memberIds] of redundantGroupsByKey.entries()) {
    if (memberIds.length <= 1) {
      continue;
    }
    const sortedMemberIds = [...memberIds].sort((leftId, rightId) =>
      compareDeviceIdsByLabel(leftId, rightId, deviceById)
    );
    const childIds = groupKey.split('|').filter((childId) => childId.length > 0);
    const groupCenter = new Vector3();
    for (const memberId of sortedMemberIds) {
      groupCenter.add(anchorByDeviceId.get(memberId)?.clone() ?? new Vector3());
    }
    groupCenter.divideScalar(sortedMemberIds.length);

    const childCenter = new Vector3();
    let childCount = 0;
    for (const childId of childIds) {
      const childAnchor = anchorByDeviceId.get(childId);
      if (!childAnchor) {
        continue;
      }
      childCenter.add(childAnchor);
      childCount += 1;
    }
    if (childCount > 0) {
      childCenter.divideScalar(childCount);
    } else {
      childCenter.copy(groupCenter);
    }

    const forwardX = childCenter.x - groupCenter.x;
    const forwardZ = childCenter.z - groupCenter.z;
    let baseAngle = Math.atan2(forwardZ, forwardX);
    if (Math.hypot(forwardX, forwardZ) < 0.0001) {
      baseAngle = hash01(`redundant-group:${groupKey}`) * Math.PI * 2;
    }
    const lateralAngle = baseAngle + Math.PI / 2;
    const lateralStep = sortedMemberIds.reduce((maximum, memberId) => {
      const device = deviceById.get(memberId);
      return Math.max(
        maximum,
        devicePlanarMaxDiameter(device) + devicePlanarClearance(device) * 2 + 0.42
      );
    }, 2.4);

    if (sortedMemberIds.length === 2) {
      sortedMemberIds.forEach((memberId, index) => {
        const direction = index === 0 ? -1 : 1;
        const target = new Vector3(
          groupCenter.x + Math.cos(lateralAngle) * (lateralStep * 0.5) * direction,
          anchorByDeviceId.get(memberId)?.y ?? groupCenter.y,
          groupCenter.z + Math.sin(lateralAngle) * (lateralStep * 0.5) * direction
        );
        redundantTargetAnchorByDeviceId.set(memberId, target);
        redundantGroupIdByDeviceId.set(memberId, groupKey);
      });
      redundantMinDistanceByPair.set(pairKey(sortedMemberIds[0], sortedMemberIds[1]), lateralStep);
      continue;
    }

    const ringRadius = Math.max(
      lateralStep,
      lateralStep / (2 * Math.sin(Math.PI / sortedMemberIds.length))
    );
    const startAngle = lateralAngle - Math.PI / 2;
    sortedMemberIds.forEach((memberId, index) => {
      const angle = startAngle + (Math.PI * 2 * index) / sortedMemberIds.length;
      const target = new Vector3(
        groupCenter.x + Math.cos(angle) * ringRadius,
        anchorByDeviceId.get(memberId)?.y ?? groupCenter.y,
        groupCenter.z + Math.sin(angle) * ringRadius
      );
      redundantTargetAnchorByDeviceId.set(memberId, target);
      redundantGroupIdByDeviceId.set(memberId, groupKey);
    });
    for (let leftIndex = 0; leftIndex < sortedMemberIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sortedMemberIds.length; rightIndex += 1) {
        const leftId = sortedMemberIds[leftIndex];
        const rightId = sortedMemberIds[rightIndex];
        const leftTarget = redundantTargetAnchorByDeviceId.get(leftId);
        const rightTarget = redundantTargetAnchorByDeviceId.get(rightId);
        if (!leftTarget || !rightTarget) {
          continue;
        }
        redundantMinDistanceByPair.set(
          pairKey(leftId, rightId),
          leftTarget.distanceTo(rightTarget) * 0.92
        );
      }
    }
  }

  for (const [deviceId, targetAnchor] of redundantTargetAnchorByDeviceId.entries()) {
    anchorByDeviceId.set(deviceId, targetAnchor.clone());
  }

  const orderedIds = devices.map((device) => device.id).sort((leftId, rightId) => leftId.localeCompare(rightId));
  const positions = new Map(
    Array.from(anchorByDeviceId.entries(), ([deviceId, anchor]) => [deviceId, anchor.clone()])
  );
  const maxStep = 0.18;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const forces = new Map(orderedIds.map((deviceId) => [deviceId, { x: 0, z: 0 }]));

    for (let leftIndex = 0; leftIndex < orderedIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < orderedIds.length; rightIndex += 1) {
        const leftId = orderedIds[leftIndex];
        const rightId = orderedIds[rightIndex];
        const leftPosition = positions.get(leftId);
        const rightPosition = positions.get(rightId);
        if (!leftPosition || !rightPosition) {
          continue;
        }

        let dx = rightPosition.x - leftPosition.x;
        let dz = rightPosition.z - leftPosition.z;
        let distance = Math.hypot(dx, dz);
        if (distance < 0.0001) {
          const angle = hash01(`cluster-layout:${pairKey(leftId, rightId)}`) * Math.PI * 2;
          dx = Math.cos(angle) * 0.001;
          dz = Math.sin(angle) * 0.001;
          distance = 0.001;
        }

        const minDistance =
          devicePlanarSupport(deviceById.get(leftId), dx, dz) +
          devicePlanarSupport(deviceById.get(rightId), dx, dz) +
          devicePlanarClearance(deviceById.get(leftId)) +
          devicePlanarClearance(deviceById.get(rightId)) +
          0.12;
        const redundantMinDistance = redundantMinDistanceByPair.get(pairKey(leftId, rightId)) ?? 0;
        const sameClusterDepthMinDistance =
          sameClusterDepthMinDistanceByPair.get(pairKey(leftId, rightId)) ?? 0;
        const effectiveMinDistance = Math.max(minDistance, redundantMinDistance, sameClusterDepthMinDistance);
        if (distance >= effectiveMinDistance) {
          continue;
        }

        const strength = ((effectiveMinDistance - distance) / effectiveMinDistance) * 0.2;
        const unitX = dx / distance;
        const unitZ = dz / distance;
        const leftForce = forces.get(leftId);
        const rightForce = forces.get(rightId);
        if (!leftForce || !rightForce) {
          continue;
        }
        leftForce.x -= unitX * strength;
        leftForce.z -= unitZ * strength;
        rightForce.x += unitX * strength;
        rightForce.z += unitZ * strength;
      }
    }

    for (const deviceId of orderedIds) {
      const anchor = anchorByDeviceId.get(deviceId);
      const position = positions.get(deviceId);
      const force = forces.get(deviceId);
      if (!anchor || !position || !force) {
        continue;
      }
      const anchorStrength =
        (rootSet.has(deviceId) ? 0.3 : 0.26) +
        (redundantGroupIdByDeviceId.has(deviceId) ? 0.08 : 0) -
        (sameClusterDepthProtectedDeviceIds.has(deviceId) &&
        !redundantGroupIdByDeviceId.has(deviceId)
          ? 0.12
          : 0);
      force.x += (anchor.x - position.x) * anchorStrength;
      force.z += (anchor.z - position.z) * anchorStrength;
    }

    for (const deviceId of orderedIds) {
      const position = positions.get(deviceId);
      const force = forces.get(deviceId);
      if (!position || !force) {
        continue;
      }
      position.x += clampMagnitude(force.x, maxStep);
      position.z += clampMagnitude(force.z, maxStep);
    }
  }

  recenterPositionsAroundRootCentroid(positions, roots);

  return new Map(
    Array.from(positions.entries(), ([deviceId, position]) => {
      const anchor = anchorByDeviceId.get(deviceId) ?? position;
      return [deviceId, new Vector3(position.x, anchor.y, position.z)];
    })
  );
}
