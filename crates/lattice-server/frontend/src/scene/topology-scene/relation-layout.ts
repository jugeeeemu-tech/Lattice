import { Vector3 } from 'three';

import type { ViewDevice } from '../../generated';

export function recenterPositionsAroundRootCentroid(
  positions: Map<string, Vector3>,
  rootIds: Iterable<string>
): Map<string, Vector3> {
  const roots = Array.from(rootIds)
    .map((rootId) => positions.get(rootId))
    .filter((position): position is Vector3 => Boolean(position));

  if (roots.length <= 1) {
    return positions;
  }

  const centroid = new Vector3();
  for (const position of roots) {
    centroid.add(position);
  }
  centroid.divideScalar(roots.length);

  if (Math.abs(centroid.x) < 0.0001 && Math.abs(centroid.z) < 0.0001) {
    return positions;
  }

  for (const position of positions.values()) {
    position.x -= centroid.x;
    position.z -= centroid.z;
  }

  return positions;
}

interface RelationLayoutInput {
  childIdsByDeviceId: Map<string, string[]>;
  deviceById: Map<string, ViewDevice>;
  parentIdsByDeviceId: Map<string, string[]>;
  peerIdsByDeviceId: Map<string, string[]>;
  primaryChildrenByDeviceId: Map<string, string[]>;
  primaryParentDeviceById: Map<string, string>;
  rootDeviceIds: string[];
}

export interface RelationLayoutGraph {
  childIdsByDeviceId: Map<string, string[]>;
  depthByDeviceId: Map<string, number>;
  parentIdsByDeviceId: Map<string, string[]>;
  peerIdsByDeviceId: Map<string, string[]>;
  rootDescendantIdsByRootId: Map<string, string[]>;
  rootDeviceIds: string[];
  rootMassByDeviceId: Map<string, number>;
  rootShareByDeviceId: Map<string, Map<string, number>>;
}

function sortedVisibleIds(
  ids: Iterable<string>,
  visibleIds: Set<string>,
  deviceById: Map<string, ViewDevice>
): string[] {
  return Array.from(new Set(Array.from(ids).filter((deviceId) => visibleIds.has(deviceId)))).sort(
    (leftId, rightId) =>
      `${deviceById.get(leftId)?.label ?? leftId}`.localeCompare(
        `${deviceById.get(rightId)?.label ?? rightId}`
      )
  );
}

function normalizeRootShare(weights: Map<string, number>): Map<string, number> {
  const total = Array.from(weights.values()).reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return new Map();
  }

  return new Map(
    Array.from(weights.entries())
      .map(([rootId, value]) => [rootId, value / total] as const)
      .filter(([, value]) => value > 0.0001)
      .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
  );
}

export function buildRelationLayoutGraph(
  visibleDeviceIds: Iterable<string>,
  model: RelationLayoutInput
): RelationLayoutGraph {
  const visibleIds = new Set(visibleDeviceIds);
  const hasRelationData =
    model.rootDeviceIds.length > 0 ||
    Array.from(visibleIds).some((deviceId) => {
      const parentCount = model.parentIdsByDeviceId.get(deviceId)?.length ?? 0;
      const childCount = model.childIdsByDeviceId.get(deviceId)?.length ?? 0;
      const peerCount = model.peerIdsByDeviceId.get(deviceId)?.length ?? 0;
      return parentCount > 0 || childCount > 0 || peerCount > 0;
    });

  const childIdsByDeviceId = new Map<string, string[]>();
  const parentIdsByDeviceId = new Map<string, string[]>();
  const peerIdsByDeviceId = new Map<string, string[]>();

  for (const deviceId of visibleIds) {
    if (hasRelationData) {
      childIdsByDeviceId.set(
        deviceId,
        sortedVisibleIds(model.childIdsByDeviceId.get(deviceId) ?? [], visibleIds, model.deviceById)
      );
      parentIdsByDeviceId.set(
        deviceId,
        sortedVisibleIds(model.parentIdsByDeviceId.get(deviceId) ?? [], visibleIds, model.deviceById)
      );
      peerIdsByDeviceId.set(
        deviceId,
        sortedVisibleIds(model.peerIdsByDeviceId.get(deviceId) ?? [], visibleIds, model.deviceById)
      );
    } else {
      childIdsByDeviceId.set(
        deviceId,
        sortedVisibleIds(
          model.primaryChildrenByDeviceId.get(deviceId) ?? [],
          visibleIds,
          model.deviceById
        )
      );
      const parentId = model.primaryParentDeviceById.get(deviceId);
      parentIdsByDeviceId.set(deviceId, parentId && visibleIds.has(parentId) ? [parentId] : []);
      peerIdsByDeviceId.set(deviceId, []);
    }
  }

  const roots = hasRelationData
    ? sortedVisibleIds(model.rootDeviceIds, visibleIds, model.deviceById)
    : sortedVisibleIds(
        Array.from(visibleIds).filter((deviceId) => (parentIdsByDeviceId.get(deviceId)?.length ?? 0) === 0),
        visibleIds,
        model.deviceById
      );

  if (roots.length === 0) {
    roots.push(
      ...sortedVisibleIds(
        Array.from(visibleIds).filter((deviceId) => (parentIdsByDeviceId.get(deviceId)?.length ?? 0) === 0),
        visibleIds,
        model.deviceById
      )
    );
  }

  const depthByDeviceId = new Map<string, number>();
  const queue = roots.map((deviceId) => ({ depth: 0, deviceId }));
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    const existingDepth = depthByDeviceId.get(current.deviceId);
    if (existingDepth !== undefined && existingDepth <= current.depth) {
      continue;
    }

    depthByDeviceId.set(current.deviceId, current.depth);
    for (const childId of childIdsByDeviceId.get(current.deviceId) ?? []) {
      queue.push({ depth: current.depth + 1, deviceId: childId });
    }
  }

  const unresolvedIds = sortedVisibleIds(
    Array.from(visibleIds).filter((deviceId) => !depthByDeviceId.has(deviceId)),
    visibleIds,
    model.deviceById
  );
  for (const deviceId of unresolvedIds) {
    depthByDeviceId.set(deviceId, 0);
    if (!roots.includes(deviceId)) {
      roots.push(deviceId);
    }
  }

  const rootShareByDeviceId = new Map<string, Map<string, number>>();
  for (const rootId of roots) {
    rootShareByDeviceId.set(rootId, new Map([[rootId, 1]]));
  }

  const devicesByDepth = Array.from(depthByDeviceId.entries())
    .sort(
      ([leftId, leftDepth], [rightId, rightDepth]) =>
        leftDepth - rightDepth ||
        `${model.deviceById.get(leftId)?.label ?? leftId}`.localeCompare(
          `${model.deviceById.get(rightId)?.label ?? rightId}`
        )
    )
    .map(([deviceId]) => deviceId);

  for (const deviceId of devicesByDepth) {
    if (rootShareByDeviceId.has(deviceId)) {
      continue;
    }

    const parentIds = parentIdsByDeviceId
      .get(deviceId)
      ?.filter((parentId) => rootShareByDeviceId.has(parentId)) ?? [];
    if (parentIds.length === 0) {
      rootShareByDeviceId.set(deviceId, new Map());
      continue;
    }

    const combined = new Map<string, number>();
    for (const parentId of parentIds) {
      for (const [rootId, share] of rootShareByDeviceId.get(parentId) ?? []) {
        combined.set(rootId, (combined.get(rootId) ?? 0) + share);
      }
    }
    rootShareByDeviceId.set(deviceId, normalizeRootShare(combined));
  }

  const rootDescendantIdsByRootId = new Map<string, string[]>(
    roots.map((rootId) => [rootId, [] as string[]])
  );
  const rootMassByDeviceId = new Map<string, number>(roots.map((rootId) => [rootId, 0]));

  for (const deviceId of devicesByDepth) {
    const childCount = childIdsByDeviceId.get(deviceId)?.length ?? 0;
    const peerCount = peerIdsByDeviceId.get(deviceId)?.length ?? 0;
    const deviceWeight = 1 + childCount * 0.45 + peerCount * 0.2;
    for (const [rootId, share] of rootShareByDeviceId.get(deviceId) ?? []) {
      const descendantIds = rootDescendantIdsByRootId.get(rootId) ?? [];
      descendantIds.push(deviceId);
      rootDescendantIdsByRootId.set(rootId, descendantIds);
      rootMassByDeviceId.set(rootId, (rootMassByDeviceId.get(rootId) ?? 0) + deviceWeight * share);
    }
  }

  for (const [rootId, descendantIds] of rootDescendantIdsByRootId.entries()) {
    rootDescendantIdsByRootId.set(rootId, sortedVisibleIds(descendantIds, visibleIds, model.deviceById));
  }

  return {
    childIdsByDeviceId,
    depthByDeviceId,
    parentIdsByDeviceId,
    peerIdsByDeviceId,
    rootDescendantIdsByRootId,
    rootDeviceIds: roots,
    rootMassByDeviceId,
    rootShareByDeviceId,
  };
}

export function buildRelationRootAnchors(graph: RelationLayoutGraph): Map<string, Vector3> {
  const roots = graph.rootDeviceIds;
  const anchors = new Map<string, Vector3>();
  if (roots.length === 0) {
    return anchors;
  }

  if (roots.length === 1) {
    anchors.set(roots[0], new Vector3(0, 0, 0));
    return anchors;
  }

  const membershipCountByDeviceId = new Map<string, number>();
  for (const descendantIds of graph.rootDescendantIdsByRootId.values()) {
    for (const deviceId of descendantIds) {
      membershipCountByDeviceId.set(deviceId, (membershipCountByDeviceId.get(deviceId) ?? 0) + 1);
    }
  }

  const sharedDeviceCount = Array.from(membershipCountByDeviceId.values()).filter((count) => count > 1).length;
  const totalMass = roots.reduce((sum, rootId) => sum + (graph.rootMassByDeviceId.get(rootId) ?? 1), 0);
  const sharedRatio =
    membershipCountByDeviceId.size > 0 ? sharedDeviceCount / membershipCountByDeviceId.size : 0;

  if (roots.length === 2) {
    const spacing = Math.max(5.5, Math.min(9.5, 7.8 + Math.sqrt(totalMass) * 0.18 - sharedRatio * 2.2));
    anchors.set(roots[0], new Vector3(-spacing / 2, 0, 0));
    anchors.set(roots[1], new Vector3(spacing / 2, 0, 0));
    return anchors;
  }

  const radius = Math.max(5.8, Math.min(10.5, 5.8 + Math.sqrt(totalMass) * 0.18 - sharedRatio * 1.4));
  for (let index = 0; index < roots.length; index += 1) {
    const angle = (Math.PI * 2 * index) / roots.length - Math.PI / 2;
    anchors.set(roots[index], new Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  }

  return anchors;
}
