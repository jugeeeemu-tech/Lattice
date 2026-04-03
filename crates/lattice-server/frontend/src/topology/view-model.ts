import type {
  DeploymentType,
  DeviceRole,
  DiscoveryState,
  TreeRow,
  ViewDevice,
  ViewLink,
  ViewSnapshot,
} from '../generated';
import { deviceGuestKindLabel } from './device-visuals';

const ROLE_LABELS: Record<DeviceRole, string> = {
  bridge: 'Bridge',
  router: 'Router',
  server: 'Server',
  switch: 'Switch',
  unknown: 'Unknown',
};

const DEPLOYMENT_LABELS: Record<DeploymentType, string> = {
  physical: 'Physical',
  unknown: 'Unknown deployment',
  virtual: 'Virtual',
};

const DEPLOYMENT_COLORS: Record<DeploymentType, number> = {
  physical: 0x0f766e,
  unknown: 0x64748b,
  virtual: 0xd97706,
};

const PROTOCOL_LABELS: Record<string, string> = {
  lldp: 'LLDP',
  proxmox_guest_link: 'Proxmox guest',
  proxmox_uplink: 'Proxmox uplink',
};

export interface SidebarEntry {
  id: string;
  device_id: string;
  label: string;
  tree_row_id: string | null;
  source: 'flat' | 'tree';
  host_label: string | null;
}

export interface GuestHighlight {
  accessLinkId: string;
  trunkLinkId: string | null;
}

export interface PathState {
  deviceIds: Set<string>;
  guestHighlight: GuestHighlight | null;
  linkIds: Set<string>;
  resolvedNetworkCidrByLink: Record<string, string>;
}

export interface EmptyState {
  body: string;
  title: string;
}

export interface HoverCardState {
  body: string;
  title: string;
  x: number;
  y: number;
}

export interface DerivedTopologyModel {
  childIdsByDeviceId: Map<string, string[]>;
  deviceById: Map<string, ViewDevice>;
  entryIdsByDeviceId: Map<string, string[]>;
  parentIdsByDeviceId: Map<string, string[]>;
  peerIdsByDeviceId: Map<string, string[]>;
  primaryChildrenByDeviceId: Map<string, string[]>;
  primaryEntryByDevice: Map<string, string>;
  primaryParentDeviceById: Map<string, string>;
  primaryRowByDevice: Map<string, string>;
  renderableDeviceIds: Set<string>;
  rowById: Map<string, TreeRow>;
  rowChildrenById: Map<string, string[]>;
  rowDepthById: Map<string, number>;
  rowIdsByDeviceId: Map<string, string[]>;
  rowParentById: Map<string, string>;
  rootDeviceIds: string[];
  sceneDeviceIds: Set<string>;
  sidebarChildrenById: Map<string, string[]>;
  sidebarEntryById: Map<string, SidebarEntry>;
  treeEntryIdByRowId: Map<string, string>;
  treeRootEntryIds: string[];
  visibleLinkIds: Set<string>;
  visibleRowIds: Set<string>;
}

function sortDeviceIdsByLabel(
  deviceIds: string[],
  deviceById: Map<string, ViewDevice>
): string[] {
  return [...deviceIds].sort((leftId, rightId) =>
    compareByLabel(deviceById.get(leftId), deviceById.get(rightId))
  );
}

function normalizeText(value: string | null | undefined, fallback = ''): string {
  const text = `${value ?? ''}`.trim();
  return text.length > 0 ? text : fallback;
}

function compareByLabel(
  left: { id: string; label: string } | null | undefined,
  right: { id: string; label: string } | null | undefined
): number {
  const leftLabel = normalizeText(left?.label, 'Unknown').toLowerCase();
  const rightLabel = normalizeText(right?.label, 'Unknown').toLowerCase();
  if (leftLabel === rightLabel) {
    return normalizeText(left?.id).localeCompare(normalizeText(right?.id));
  }
  return leftLabel.localeCompare(rightLabel);
}

export function findRowPath(
  rowId: string | null,
  parentByRowId: Map<string, string>
): string[] {
  const path: string[] = [];
  let current = rowId;
  const seen = new Set<string>();

  while (current && !seen.has(current)) {
    seen.add(current);
    path.unshift(current);
    current = parentByRowId.get(current) ?? null;
  }

  return path;
}

export function roleLabel(role: DeviceRole): string {
  return ROLE_LABELS[role] ?? ROLE_LABELS.unknown;
}

export function deploymentLabel(deploymentType: DeploymentType): string {
  return DEPLOYMENT_LABELS[deploymentType] ?? DEPLOYMENT_LABELS.unknown;
}

export function deploymentColor(deploymentType: DeploymentType): number {
  return DEPLOYMENT_COLORS[deploymentType] ?? DEPLOYMENT_COLORS.unknown;
}

export function protocolLabel(protocol: string): string {
  return PROTOCOL_LABELS[protocol] ?? protocol;
}

function buildRowModel(
  snapshot: ViewSnapshot
): Pick<
  DerivedTopologyModel,
  | 'deviceById'
  | 'primaryRowByDevice'
  | 'renderableDeviceIds'
  | 'rowById'
  | 'rowChildrenById'
  | 'rowDepthById'
  | 'rowIdsByDeviceId'
  | 'rowParentById'
> {
  const rowById = new Map(snapshot.tree_rows.map((row) => [row.id, row]));
  const rowParentById = new Map<string, string>();
  const rowChildrenById = new Map(snapshot.tree_rows.map((row) => [row.id, [] as string[]]));
  const rowIdsByDeviceId = new Map<string, string[]>();
  const primaryRowByDevice = new Map(
    Object.entries(snapshot.primary_row_by_device).map(([deviceId, rowId]) => [deviceId, rowId])
  );

  for (const row of snapshot.tree_rows) {
    const rowIds = rowIdsByDeviceId.get(row.device_id) ?? [];
    rowIds.push(row.id);
    rowIdsByDeviceId.set(row.device_id, rowIds);
  }

  for (const edge of snapshot.tree_edges) {
    if (!rowById.has(edge.parent_row_id) || !rowById.has(edge.child_row_id)) {
      continue;
    }
    rowParentById.set(edge.child_row_id, edge.parent_row_id);
    const children = rowChildrenById.get(edge.parent_row_id) ?? [];
    children.push(edge.child_row_id);
    rowChildrenById.set(edge.parent_row_id, children);
  }

  for (const [rowId, children] of rowChildrenById) {
    children.sort((leftId, rightId) => compareByLabel(rowById.get(leftId), rowById.get(rightId)));
    rowChildrenById.set(rowId, children);
  }

  for (const [deviceId, rowIds] of rowIdsByDeviceId) {
    rowIds.sort((leftId, rightId) => compareByLabel(rowById.get(leftId), rowById.get(rightId)));
    if (!primaryRowByDevice.has(deviceId) && rowIds.length > 0) {
      primaryRowByDevice.set(deviceId, rowIds[0]);
    }
  }

  const rowDepthById = new Map<string, number>();
  const roots = snapshot.tree_rows
    .filter((row) => !rowParentById.has(row.id))
    .sort((left, right) => compareByLabel(left, right));
  const visited = new Set<string>();

  const walk = (rowId: string, depth: number) => {
    if (visited.has(rowId)) {
      return;
    }
    visited.add(rowId);
    rowDepthById.set(rowId, depth);

    for (const childRowId of rowChildrenById.get(rowId) ?? []) {
      walk(childRowId, depth + 1);
    }
  };

  for (const root of roots) {
    walk(root.id, 0);
  }
  for (const row of snapshot.tree_rows) {
    if (!visited.has(row.id)) {
      walk(row.id, 0);
    }
  }

  const renderableDeviceIds = snapshot.tree_rows.length
    ? new Set(snapshot.tree_rows.map((row) => row.device_id))
    : new Set(snapshot.devices.map((device) => device.id));

  return {
    deviceById: new Map(snapshot.devices.map((device) => [device.id, device])),
    primaryRowByDevice,
    renderableDeviceIds,
    rowById,
    rowChildrenById,
    rowDepthById,
    rowIdsByDeviceId,
    rowParentById,
  };
}

function buildPrimaryDeviceTree(
  rowModel: Pick<
    DerivedTopologyModel,
    | 'primaryRowByDevice'
    | 'renderableDeviceIds'
    | 'rowById'
    | 'rowParentById'
    | 'deviceById'
  >
): Pick<DerivedTopologyModel, 'primaryChildrenByDeviceId' | 'primaryParentDeviceById'> {
  const primaryParentDeviceById = new Map<string, string>();
  const primaryChildrenByDeviceId = new Map(
    Array.from(rowModel.renderableDeviceIds, (deviceId) => [deviceId, [] as string[]])
  );

  for (const deviceId of rowModel.renderableDeviceIds) {
    const rowId =
      rowModel.primaryRowByDevice.get(deviceId) ?? null;
    if (!rowId) {
      continue;
    }

    const parentRowId = rowModel.rowParentById.get(rowId);
    if (!parentRowId) {
      continue;
    }

    const parentRow = rowModel.rowById.get(parentRowId);
    if (!parentRow || parentRow.device_id === deviceId) {
      continue;
    }

    primaryParentDeviceById.set(deviceId, parentRow.device_id);
    const children = primaryChildrenByDeviceId.get(parentRow.device_id) ?? [];
    children.push(deviceId);
    primaryChildrenByDeviceId.set(parentRow.device_id, children);
  }

  for (const [deviceId, childIds] of primaryChildrenByDeviceId) {
    childIds.sort((leftId, rightId) =>
      compareByLabel(rowModel.deviceById.get(leftId), rowModel.deviceById.get(rightId))
    );
    primaryChildrenByDeviceId.set(deviceId, childIds);
  }

  return { primaryChildrenByDeviceId, primaryParentDeviceById };
}

function buildRelationsModel(
  snapshot: ViewSnapshot,
  rowModel: Pick<DerivedTopologyModel, 'deviceById' | 'renderableDeviceIds'>
): Pick<
  DerivedTopologyModel,
  'childIdsByDeviceId' | 'parentIdsByDeviceId' | 'peerIdsByDeviceId' | 'rootDeviceIds'
> {
  const childIdsByDeviceId = new Map<string, string[]>();
  const parentIdsByDeviceId = new Map<string, string[]>();
  const peerIdsByDeviceId = new Map<string, string[]>();

  for (const deviceId of rowModel.renderableDeviceIds) {
    childIdsByDeviceId.set(deviceId, []);
    parentIdsByDeviceId.set(deviceId, []);
    peerIdsByDeviceId.set(deviceId, []);
  }

  for (const [deviceId, relations] of Object.entries(snapshot.device_relations ?? {})) {
    if (!rowModel.renderableDeviceIds.has(deviceId)) {
      continue;
    }
    childIdsByDeviceId.set(
      deviceId,
      sortDeviceIdsByLabel(
        (relations.children ?? []).filter((childId) => rowModel.renderableDeviceIds.has(childId)),
        rowModel.deviceById
      )
    );
    parentIdsByDeviceId.set(
      deviceId,
      sortDeviceIdsByLabel(
        (relations.parents ?? []).filter((parentId) => rowModel.renderableDeviceIds.has(parentId)),
        rowModel.deviceById
      )
    );
    peerIdsByDeviceId.set(
      deviceId,
      sortDeviceIdsByLabel(
        (relations.peers ?? []).filter((peerId) => rowModel.renderableDeviceIds.has(peerId)),
        rowModel.deviceById
      )
    );
  }

  const rootDeviceIds = sortDeviceIdsByLabel(
    (snapshot.root_device_ids ?? []).filter((deviceId) => rowModel.renderableDeviceIds.has(deviceId)),
    rowModel.deviceById
  );

  return {
    childIdsByDeviceId,
    parentIdsByDeviceId,
    peerIdsByDeviceId,
    rootDeviceIds,
  };
}

function buildSidebarModel(
  snapshot: ViewSnapshot,
  rowModel: Pick<
    DerivedTopologyModel,
    | 'deviceById'
    | 'primaryRowByDevice'
    | 'renderableDeviceIds'
    | 'rowById'
    | 'rowChildrenById'
    | 'rowParentById'
  >
): Pick<
  DerivedTopologyModel,
  | 'entryIdsByDeviceId'
  | 'primaryEntryByDevice'
  | 'sidebarChildrenById'
  | 'sidebarEntryById'
  | 'treeEntryIdByRowId'
  | 'treeRootEntryIds'
> {
  const treeRootEntryIds: string[] = [];
  const sidebarEntryById = new Map<string, SidebarEntry>();
  const sidebarChildrenById = new Map<string, string[]>();
  const entryIdsByDeviceId = new Map<string, string[]>();
  const primaryEntryByDevice = new Map<string, string>();
  const treeEntryIdByRowId = new Map<string, string>();

  const registerSidebarEntry = (entry: SidebarEntry, parentEntryId: string | null = null) => {
    sidebarEntryById.set(entry.id, entry);

    const entryIds = entryIdsByDeviceId.get(entry.device_id) ?? [];
    entryIds.push(entry.id);
    entryIdsByDeviceId.set(entry.device_id, entryIds);
    if (!primaryEntryByDevice.has(entry.device_id)) {
      primaryEntryByDevice.set(entry.device_id, entry.id);
    }

    if (parentEntryId) {
      const children = sidebarChildrenById.get(parentEntryId) ?? [];
      children.push(entry.id);
      sidebarChildrenById.set(parentEntryId, children);
    }

    if (!sidebarChildrenById.has(entry.id)) {
      sidebarChildrenById.set(entry.id, []);
    }

    return entry.id;
  };

  const registerTreeEntry = (rowId: string, parentEntryId: string | null): string | null => {
    const row = rowModel.rowById.get(rowId);
    if (!row) {
      return null;
    }

    const device = rowModel.deviceById.get(row.device_id) ?? null;
    const entryId = `tree:${row.id}`;
    const entry: SidebarEntry = {
      device_id: row.device_id,
      host_label: device?.host_label ?? null,
      id: entryId,
      label: row.label || device?.label || 'Unknown',
      source: 'tree',
      tree_row_id: row.id,
    };

    registerSidebarEntry(entry, parentEntryId);
    treeEntryIdByRowId.set(row.id, entryId);

    const childEntryIds: string[] = [];
    for (const childRowId of rowModel.rowChildrenById.get(row.id) ?? []) {
      const childEntryId = registerTreeEntry(childRowId, entryId);
      if (childEntryId) {
        childEntryIds.push(childEntryId);
      }
    }
    sidebarChildrenById.set(entryId, childEntryIds);

    return entryId;
  };

  if (snapshot.tree_rows.length > 0) {
    const roots = snapshot.tree_rows
      .filter((row) => !rowModel.rowParentById.has(row.id))
      .sort((left, right) => compareByLabel(left, right));
    for (const root of roots) {
      const entryId = registerTreeEntry(root.id, null);
      if (entryId) {
        treeRootEntryIds.push(entryId);
      }
    }
  } else if (rowModel.renderableDeviceIds.size > 0) {
    const roots = snapshot.devices
      .filter((device) => rowModel.renderableDeviceIds.has(device.id))
      .sort((left, right) => compareByLabel(left, right));
    for (const device of roots) {
      treeRootEntryIds.push(
        registerSidebarEntry({
          device_id: device.id,
          host_label: device.host_label ?? null,
          id: `flat:${device.id}`,
          label: device.label || 'Unknown',
          source: 'flat',
          tree_row_id: rowModel.primaryRowByDevice.get(device.id) ?? null,
        })
      );
    }
  }

  return {
    entryIdsByDeviceId,
    primaryEntryByDevice,
    sidebarChildrenById,
    sidebarEntryById,
    treeEntryIdByRowId,
    treeRootEntryIds,
  };
}

function computeVisibleRowIds(
  snapshot: ViewSnapshot,
  rowById: Map<string, TreeRow>,
  rowParentById: Map<string, string>,
  rowChildrenById: Map<string, string[]>,
  treeEntryIdByRowId: Map<string, string>,
  collapsedEntryIds: ReadonlySet<string>
): Set<string> {
  if (snapshot.tree_rows.length === 0) {
    return new Set();
  }

  const visibleRowIds = new Set<string>();
  const roots = snapshot.tree_rows
    .filter((row) => !rowParentById.has(row.id))
    .sort((left, right) => compareByLabel(left, right));

  const visit = (rowId: string) => {
    if (!rowById.has(rowId) || visibleRowIds.has(rowId)) {
      return;
    }

    visibleRowIds.add(rowId);
    const entryId = treeEntryIdByRowId.get(rowId);
    if (entryId && collapsedEntryIds.has(entryId)) {
      return;
    }

    for (const childRowId of rowChildrenById.get(rowId) ?? []) {
      visit(childRowId);
    }
  };

  for (const root of roots) {
    visit(root.id);
  }

  return visibleRowIds;
}

export function buildTopologyModel(
  snapshot: ViewSnapshot,
  collapsedEntryIds: ReadonlySet<string>
): DerivedTopologyModel {
  const rowModel = buildRowModel(snapshot);
  const relationsModel = buildRelationsModel(snapshot, rowModel);
  const primaryTree = buildPrimaryDeviceTree(rowModel);
  const sidebarModel = buildSidebarModel(snapshot, rowModel);
  const visibleRowIds = computeVisibleRowIds(
    snapshot,
    rowModel.rowById,
    rowModel.rowParentById,
    rowModel.rowChildrenById,
    sidebarModel.treeEntryIdByRowId,
    collapsedEntryIds
  );

  const sceneDeviceIds = visibleRowIds.size
    ? new Set(
        Array.from(visibleRowIds)
          .map((rowId) => rowModel.rowById.get(rowId)?.device_id ?? null)
          .filter((deviceId): deviceId is string => Boolean(deviceId))
      )
    : new Set(rowModel.renderableDeviceIds);
  const visibleLinkIds = new Set(
    snapshot.links
      .filter(
        (link) =>
          sceneDeviceIds.has(link.local_device_id) && sceneDeviceIds.has(link.remote_device_id)
      )
      .map((link) => link.id)
  );

  return {
    ...relationsModel,
    ...primaryTree,
    ...rowModel,
    ...sidebarModel,
    sceneDeviceIds,
    visibleLinkIds,
    visibleRowIds,
  };
}

export function primaryRowForDevice(
  model: DerivedTopologyModel,
  deviceId: string | null
): string | null {
  if (!deviceId) {
    return null;
  }

  return (
    model.primaryRowByDevice.get(deviceId) ??
    model.rowIdsByDeviceId.get(deviceId)?.[0] ??
    null
  );
}

export function preferredEntryForDevice(
  model: DerivedTopologyModel,
  deviceId: string | null
): string | null {
  if (!deviceId) {
    return null;
  }

  const entryIds = model.entryIdsByDeviceId.get(deviceId) ?? [];
  const visibleEntryId = entryIds.find((entryId) => {
    const rowId = model.sidebarEntryById.get(entryId)?.tree_row_id ?? null;
    return !rowId || model.visibleRowIds.has(rowId);
  });
  return visibleEntryId ?? model.primaryEntryByDevice.get(deviceId) ?? entryIds[0] ?? null;
}

export function preferredRowForDevice(
  model: DerivedTopologyModel,
  deviceId: string | null
): string | null {
  if (!deviceId) {
    return null;
  }

  const preferredEntryId = preferredEntryForDevice(model, deviceId);
  return (
    model.sidebarEntryById.get(preferredEntryId ?? '')?.tree_row_id ??
    primaryRowForDevice(model, deviceId)
  );
}

export function nearestVisibleAncestorRowId(
  model: DerivedTopologyModel,
  rowId: string | null
): string | null {
  for (let index = findRowPath(rowId, model.rowParentById).length - 1; index >= 0; index -= 1) {
    const candidateRowId = findRowPath(rowId, model.rowParentById)[index];
    if (model.visibleRowIds.has(candidateRowId)) {
      return candidateRowId;
    }
  }
  return null;
}

export function pathEntryIdsForRow(
  model: DerivedTopologyModel,
  rowId: string | null
): Set<string> {
  const entryIds = new Set<string>();
  for (const pathRowId of findRowPath(rowId, model.rowParentById)) {
    const entryId = model.treeEntryIdByRowId.get(pathRowId);
    if (entryId) {
      entryIds.add(entryId);
    }
  }
  return entryIds;
}

export function entryMetaText(model: DerivedTopologyModel, entry: SidebarEntry): string {
  const device = model.deviceById.get(entry.device_id) ?? null;
  if (!device) {
    return '';
  }

  const fragments: string[] = [];
  if (device.device_role !== 'unknown') {
    fragments.push(roleLabel(device.device_role));
  }
  const guestLabel = deviceGuestKindLabel(device);
  if (guestLabel) {
    fragments.push(guestLabel);
  }
  if (device.host_label) {
    fragments.push(`${device.host_label} 上`);
  }
  return fragments.join(' · ');
}

export function deviceSummary(device: ViewDevice): string[] {
  const details = [roleLabel(device.device_role)];
  const guestLabel = deviceGuestKindLabel(device);
  if (guestLabel) {
    details.push(guestLabel);
  }
  if (device.deployment_type !== 'unknown') {
    details.push(deploymentLabel(device.deployment_type));
  }
  if (device.host_label) {
    details.push(`${device.host_label} 上`);
  }
  return details;
}

export function buildEmptyState(
  snapshot: ViewSnapshot,
  sceneDeviceCount: number
): EmptyState | null {
  if (sceneDeviceCount > 0) {
    return null;
  }

  const status = snapshot.discovery_status.state;
  return {
    body:
      ({
        discovering: '最新の構成を組み立てています。完了後に自動で切り替わります。',
        failed:
          snapshot.discovery_status.message ?? '探索に失敗しました。旧構成があればそのまま保持しています。',
        loading: '初回探索が完了すると、3Dビューと構成が表示されます。',
        ready: '可視化できる機器がありません。',
      } satisfies Record<DiscoveryState, string>)[status],
    title:
      ({
        discovering: 'Discovery is running',
        failed: 'Discovery failed',
        loading: 'Topology is warming up',
        ready: 'No devices to render',
      } satisfies Record<DiscoveryState, string>)[status],
  };
}

function hash01(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

function hueToRgb(p: number, q: number, t: number): number {
  if (t < 0) {
    t += 1;
  }
  if (t > 1) {
    t -= 1;
  }
  if (t < 1 / 6) {
    return p + (q - p) * 6 * t;
  }
  if (t < 1 / 2) {
    return q;
  }
  if (t < 2 / 3) {
    return p + (q - p) * (2 / 3 - t) * 6;
  }
  return p;
}

function hslToHex(h: number, s: number, l: number): number {
  if (s === 0) {
    const value = Math.round(l * 255);
    return (value << 16) | (value << 8) | value;
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const red = Math.round(hueToRgb(p, q, h + 1 / 3) * 255);
  const green = Math.round(hueToRgb(p, q, h) * 255);
  const blue = Math.round(hueToRgb(p, q, h - 1 / 3) * 255);
  return (red << 16) | (green << 8) | blue;
}

export function networkCidrColor(
  networkCidr: string | null | undefined
): number | null {
  if (!networkCidr) {
    return null;
  }

  return hslToHex(hash01(networkCidr), 0.68, 0.56);
}

export function primaryNetworkCidr(link: ViewLink): string | null {
  return link.network_cidrs?.length === 1 ? link.network_cidrs[0] : null;
}

function resolvedNetworkCidrForTaggedGuestPath(
  accessLink: ViewLink,
  routerLink: ViewLink | null
): string | null {
  const accessNetworkCidr = primaryNetworkCidr(accessLink);
  if (accessNetworkCidr) {
    return accessNetworkCidr;
  }
  if (!routerLink) {
    return null;
  }

  const vlanTag = accessLink.guest_attachment?.vlan_tag;
  const trunkVlans = routerLink.guest_attachment?.trunk_vlans ?? [];
  if (vlanTag === undefined || trunkVlans.length === 0) {
    return primaryNetworkCidr(routerLink);
  }

  const vlanIndex = trunkVlans.indexOf(vlanTag);
  if (vlanIndex >= 0 && vlanIndex < routerLink.network_cidrs.length) {
    return routerLink.network_cidrs[vlanIndex] ?? null;
  }

  return primaryNetworkCidr(routerLink);
}

export function formatSpeed(speedBps: number | null | undefined): string | null {
  if (!speedBps) {
    return null;
  }
  if (speedBps >= 1_000_000_000) {
    return `${(speedBps / 1_000_000_000).toFixed(speedBps >= 10_000_000_000 ? 0 : 1)} Gbps`;
  }
  if (speedBps >= 1_000_000) {
    return `${(speedBps / 1_000_000).toFixed(speedBps >= 10_000_000 ? 0 : 1)} Mbps`;
  }
  if (speedBps >= 1_000) {
    return `${(speedBps / 1_000).toFixed(0)} Kbps`;
  }
  return `${speedBps} bps`;
}

function connectedLinksForDevice(
  snapshot: ViewSnapshot,
  model: DerivedTopologyModel,
  deviceId: string,
  options: { excludeLinkIds?: Set<string>; visibleOnly?: boolean } = {}
): ViewLink[] {
  return snapshot.links.filter((link) => {
    if (link.local_device_id !== deviceId && link.remote_device_id !== deviceId) {
      return false;
    }
    if (options.visibleOnly !== false && !model.visibleLinkIds.has(link.id)) {
      return false;
    }
    if (options.excludeLinkIds?.has(link.id)) {
      return false;
    }
    return true;
  });
}

function otherDeviceId(link: ViewLink, deviceId: string): string | null {
  if (link.local_device_id === deviceId) {
    return link.remote_device_id;
  }
  if (link.remote_device_id === deviceId) {
    return link.local_device_id;
  }
  return null;
}

function interfaceForDevice(link: ViewLink, deviceId: string): string | null {
  if (link.local_device_id === deviceId) {
    return link.local_interface;
  }
  if (link.remote_device_id === deviceId) {
    return link.remote_interface;
  }
  return null;
}

function choosePhysicalUpstreamLink(
  model: DerivedTopologyModel,
  currentDeviceId: string,
  currentDevice: ViewDevice | null,
  candidates: ViewLink[]
): ViewLink | null {
  if (currentDevice?.upstream_interface) {
    const upstreamMatches = candidates.filter(
      (link) => interfaceForDevice(link, currentDeviceId) === currentDevice.upstream_interface
    );
    if (upstreamMatches.length === 1) {
      return upstreamMatches[0];
    }
  }

  const primaryParentDeviceId = model.primaryParentDeviceById.get(currentDeviceId) ?? null;
  if (primaryParentDeviceId) {
    const parentMatches = candidates.filter(
      (link) => otherDeviceId(link, currentDeviceId) === primaryParentDeviceId
    );
    if (parentMatches.length === 1) {
      return parentMatches[0];
    }
  }

  return candidates.length === 1 ? candidates[0] : null;
}

function guestDeviceIdForLink(
  snapshot: ViewSnapshot,
  model: DerivedTopologyModel,
  link: ViewLink
): string | null {
  if (link.protocol !== 'proxmox_guest_link' || !link.guest_attachment) {
    return null;
  }

  const localIsBridgeSide = link.local_interface === link.guest_attachment.bridge_name;
  const remoteIsBridgeSide = link.remote_interface === link.guest_attachment.bridge_name;
  if (localIsBridgeSide !== remoteIsBridgeSide) {
    return localIsBridgeSide ? link.remote_device_id : link.local_device_id;
  }

  const localDevice = model.deviceById.get(link.local_device_id) ?? null;
  const remoteDevice = model.deviceById.get(link.remote_device_id) ?? null;
  if (localDevice?.device_role === 'bridge' && remoteDevice?.device_role !== 'bridge') {
    return link.remote_device_id;
  }
  if (remoteDevice?.device_role === 'bridge' && localDevice?.device_role !== 'bridge') {
    return link.local_device_id;
  }

  const localTreeRow = primaryRowForDevice(model, link.local_device_id);
  const remoteTreeRow = primaryRowForDevice(model, link.remote_device_id);
  if (localTreeRow && !remoteTreeRow) {
    return link.remote_device_id;
  }
  if (remoteTreeRow && !localTreeRow) {
    return link.local_device_id;
  }

  return snapshot.devices.find((device) => device.id === link.local_device_id)?.device_role === 'server'
    ? link.local_device_id
    : link.remote_device_id;
}

function bridgeDeviceIdForLink(
  snapshot: ViewSnapshot,
  model: DerivedTopologyModel,
  link: ViewLink
): string | null {
  const guestDeviceId = guestDeviceIdForLink(snapshot, model, link);
  return guestDeviceId ? otherDeviceId(link, guestDeviceId) : null;
}

function preferredAccessGuestLinkForDevice(
  snapshot: ViewSnapshot,
  model: DerivedTopologyModel,
  deviceId: string
): ViewLink | null {
  const guestLinks = connectedLinksForDevice(snapshot, model, deviceId).filter(
    (link) =>
      link.protocol === 'proxmox_guest_link' &&
      link.guest_attachment &&
      guestDeviceIdForLink(snapshot, model, link) === deviceId
  );
  const taggedGuestLinks = guestLinks.filter(
    (link) => link.guest_attachment?.vlan_tag !== undefined
  );
  return taggedGuestLinks.length === 1 ? taggedGuestLinks[0] : null;
}

function preferredGuestLinkForDevice(
  snapshot: ViewSnapshot,
  model: DerivedTopologyModel,
  deviceId: string
): ViewLink | null {
  const guestLinks = connectedLinksForDevice(snapshot, model, deviceId).filter(
    (link) =>
      link.protocol === 'proxmox_guest_link' &&
      link.guest_attachment &&
      guestDeviceIdForLink(snapshot, model, link) === deviceId
  );

  const plainGuestLinks = guestLinks.filter((link) => {
    const attachment = link.guest_attachment;
    return attachment?.vlan_tag === undefined && !(attachment?.trunk_vlans?.length ?? 0);
  });
  if (plainGuestLinks.length === 1) {
    return plainGuestLinks[0];
  }

  return guestLinks.length === 1 ? guestLinks[0] : null;
}

function routerCandidateLinkForGuestLink(
  snapshot: ViewSnapshot,
  model: DerivedTopologyModel,
  link: ViewLink
): ViewLink | null {
  const attachment = link.guest_attachment;
  if (
    link.protocol !== 'proxmox_guest_link' ||
    !attachment ||
    attachment.vlan_tag === undefined
  ) {
    return null;
  }
  const vlanTag = attachment.vlan_tag;

  const bridgeDeviceId = bridgeDeviceIdForLink(snapshot, model, link);
  const candidates = snapshot.links.filter((candidate) => {
    if (
      candidate.id === link.id ||
      candidate.protocol !== 'proxmox_guest_link' ||
      !candidate.guest_attachment ||
      !model.visibleLinkIds.has(candidate.id)
    ) {
      return false;
    }
    if (candidate.guest_attachment.bridge_name !== attachment.bridge_name) {
      return false;
    }
    if (candidate.guest_attachment.vlan_tag !== undefined) {
      return false;
    }
    if (!(candidate.guest_attachment.trunk_vlans ?? []).includes(vlanTag)) {
      return false;
    }
    const candidateBridgeId = bridgeDeviceIdForLink(snapshot, model, candidate);
    if (bridgeDeviceId && candidateBridgeId && candidateBridgeId !== bridgeDeviceId) {
      return false;
    }
    const guestDeviceId = guestDeviceIdForLink(snapshot, model, candidate);
    return model.deviceById.get(guestDeviceId ?? '')?.device_role === 'router';
  });

  return candidates.length === 1 ? candidates[0] : null;
}

function physicalUpstreamPathFrom(
  snapshot: ViewSnapshot,
  model: DerivedTopologyModel,
  deviceId: string,
  excludeLinkIds = new Set<string>(),
  seenDeviceIds = new Set<string>()
): {
  deviceIds: Set<string>;
  linkIds: Set<string>;
  resolvedNetworkCidrByLink: Record<string, string>;
} {
  const deviceIds = new Set<string>();
  const linkIds = new Set<string>();
  const resolvedNetworkCidrByLink: Record<string, string> = {};
  let currentDeviceId: string | null = deviceId;
  const visitedDeviceIds = new Set(seenDeviceIds);

  while (currentDeviceId && !visitedDeviceIds.has(currentDeviceId)) {
    visitedDeviceIds.add(currentDeviceId);
    const currentDevice = model.deviceById.get(currentDeviceId) ?? null;
    const candidates = connectedLinksForDevice(snapshot, model, currentDeviceId, {
      excludeLinkIds,
    }).filter((link) => link.protocol !== 'proxmox_guest_link');

    if (candidates.length === 0) {
      break;
    }

    const chosenLink = choosePhysicalUpstreamLink(
      model,
      currentDeviceId,
      currentDevice,
      candidates
    );
    if (!chosenLink) {
      break;
    }

    const nextDeviceId = otherDeviceId(chosenLink, currentDeviceId as string);
    if (!nextDeviceId || visitedDeviceIds.has(nextDeviceId)) {
      break;
    }

    linkIds.add(chosenLink.id);
    const resolvedNetworkCidr = primaryNetworkCidr(chosenLink);
    if (resolvedNetworkCidr) {
      resolvedNetworkCidrByLink[chosenLink.id] = resolvedNetworkCidr;
    }
    deviceIds.add(nextDeviceId);
    excludeLinkIds.add(chosenLink.id);
    currentDeviceId = nextDeviceId;
  }

  return { deviceIds, linkIds, resolvedNetworkCidrByLink };
}

export function computeUpstreamPath(
  snapshot: ViewSnapshot,
  model: DerivedTopologyModel,
  deviceId: string | null
): PathState {
  const deviceIds = new Set<string>();
  const linkIds = new Set<string>();
  const resolvedNetworkCidrByLink: Record<string, string> = {};
  let guestHighlight: GuestHighlight | null = null;

  if (!deviceId) {
    return { deviceIds, guestHighlight, linkIds, resolvedNetworkCidrByLink };
  }

  deviceIds.add(deviceId);
  const guestLink = preferredAccessGuestLinkForDevice(snapshot, model, deviceId);
  if (!guestLink) {
    const fallbackGuestLink = preferredGuestLinkForDevice(snapshot, model, deviceId);
    if (fallbackGuestLink) {
      linkIds.add(fallbackGuestLink.id);
      const fallbackNetworkCidr = primaryNetworkCidr(fallbackGuestLink);
      if (fallbackNetworkCidr) {
        resolvedNetworkCidrByLink[fallbackGuestLink.id] = fallbackNetworkCidr;
      }
      const bridgeDeviceId = bridgeDeviceIdForLink(snapshot, model, fallbackGuestLink);
      if (bridgeDeviceId) {
        deviceIds.add(bridgeDeviceId);
        const continuation = physicalUpstreamPathFrom(
          snapshot,
          model,
          bridgeDeviceId,
          new Set([fallbackGuestLink.id]),
          new Set(Array.from(deviceIds).filter((candidateId) => candidateId !== bridgeDeviceId))
        );
        continuation.deviceIds.forEach((pathDeviceId) => deviceIds.add(pathDeviceId));
        continuation.linkIds.forEach((pathLinkId) => linkIds.add(pathLinkId));
        Object.assign(resolvedNetworkCidrByLink, continuation.resolvedNetworkCidrByLink);
      }
      return { deviceIds, guestHighlight, linkIds, resolvedNetworkCidrByLink };
    }

    const continuation = physicalUpstreamPathFrom(snapshot, model, deviceId);
    continuation.deviceIds.forEach((pathDeviceId) => deviceIds.add(pathDeviceId));
    continuation.linkIds.forEach((pathLinkId) => linkIds.add(pathLinkId));
    Object.assign(resolvedNetworkCidrByLink, continuation.resolvedNetworkCidrByLink);
    return { deviceIds, guestHighlight, linkIds, resolvedNetworkCidrByLink };
  }

  linkIds.add(guestLink.id);
  const accessNetworkCidr = primaryNetworkCidr(guestLink);
  if (accessNetworkCidr) {
    resolvedNetworkCidrByLink[guestLink.id] = accessNetworkCidr;
  }
  guestHighlight = {
    accessLinkId: guestLink.id,
    trunkLinkId: null,
  };

  const bridgeDeviceId = bridgeDeviceIdForLink(snapshot, model, guestLink);
  if (bridgeDeviceId) {
    deviceIds.add(bridgeDeviceId);
  }

  const routerLink = routerCandidateLinkForGuestLink(snapshot, model, guestLink);
  if (!routerLink) {
    return { deviceIds, guestHighlight, linkIds, resolvedNetworkCidrByLink };
  }

  const routerDeviceId = guestDeviceIdForLink(snapshot, model, routerLink);
  if (!routerDeviceId) {
    return { deviceIds, guestHighlight, linkIds, resolvedNetworkCidrByLink };
  }

  linkIds.add(routerLink.id);
  deviceIds.add(routerDeviceId);
  const resolvedGuestNetworkCidr = resolvedNetworkCidrForTaggedGuestPath(guestLink, routerLink);
  if (resolvedGuestNetworkCidr) {
    resolvedNetworkCidrByLink[guestLink.id] = resolvedGuestNetworkCidr;
    resolvedNetworkCidrByLink[routerLink.id] = resolvedGuestNetworkCidr;
  }
  guestHighlight = {
    ...guestHighlight,
    trunkLinkId: routerLink.id,
  };

  const continuation = physicalUpstreamPathFrom(
    snapshot,
    model,
    routerDeviceId,
    new Set([guestLink.id, routerLink.id]),
    new Set(Array.from(deviceIds).filter((candidateId) => candidateId !== routerDeviceId))
  );
  continuation.deviceIds.forEach((pathDeviceId) => deviceIds.add(pathDeviceId));
  continuation.linkIds.forEach((pathLinkId) => linkIds.add(pathLinkId));
  Object.assign(resolvedNetworkCidrByLink, continuation.resolvedNetworkCidrByLink);

  return { deviceIds, guestHighlight, linkIds, resolvedNetworkCidrByLink };
}

export function buildHoverCardForEntry(
  model: DerivedTopologyModel,
  entryId: string | null
): HoverCardState | null {
  if (!entryId) {
    return null;
  }

  const entry = model.sidebarEntryById.get(entryId);
  const device = entry ? model.deviceById.get(entry.device_id) : null;
  if (!entry || !device) {
    return null;
  }

  return {
    body: deviceSummary(device).join(' · '),
    title: entry.label || device.label || 'Unknown',
    x: 20,
    y: 20,
  };
}

export function buildHoverCardForDevice(
  model: DerivedTopologyModel,
  deviceId: string | null,
  pointer: { x: number; y: number }
): HoverCardState | null {
  if (!deviceId) {
    return null;
  }

  const device = model.deviceById.get(deviceId) ?? null;
  if (!device) {
    return null;
  }

  return {
    body: deviceSummary(device).join(' · '),
    title: device.label || device.identity_keys.sys_name || 'Unknown',
    x: pointer.x + 18,
    y: pointer.y + 18,
  };
}

export function buildHoverCardForLink(
  snapshot: ViewSnapshot,
  model: DerivedTopologyModel,
  linkId: string | null,
  pointer: { x: number; y: number }
): HoverCardState | null {
  if (!linkId) {
    return null;
  }

  const link = snapshot.links.find((candidate) => candidate.id === linkId) ?? null;
  if (!link) {
    return null;
  }

  const local = model.deviceById.get(link.local_device_id) ?? null;
  const remote = model.deviceById.get(link.remote_device_id) ?? null;
  const attachment = link.guest_attachment;
  const details = [
    `${link.local_interface}${link.local_ip ? ` · ${link.local_ip}` : ''}`,
    `${link.remote_interface}${link.remote_ip ? ` · ${link.remote_ip}` : ''}`,
    formatSpeed(link.speed_bps),
    protocolLabel(link.protocol),
    attachment?.bridge_name ? `bridge ${attachment.bridge_name}` : null,
    attachment?.vlan_tag !== undefined
      ? `VLAN ${attachment.vlan_tag}`
      : null,
    attachment?.trunk_vlans?.length ? `trunk ${attachment.trunk_vlans.join(', ')}` : null,
  ].filter((detail): detail is string => Boolean(detail));

  return {
    body: details.join(' · '),
    title: `${local?.label || link.local_interface} ↔ ${remote?.label || link.remote_interface}`,
    x: pointer.x + 18,
    y: pointer.y + 18,
  };
}
