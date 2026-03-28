import type {
  DeploymentType,
  DeviceRole,
  DiscoveryState,
  DiscoveryStatus,
  IdentityKeys,
  TreeEdge,
  TreeRow,
  ViewDevice,
  ViewGuestAttachment,
  ViewLink,
  ViewSnapshot,
} from '../model/view-snapshot';

export const EMPTY_SNAPSHOT: ViewSnapshot = Object.freeze({
  devices: [],
  links: [],
  tree_rows: [],
  tree_edges: [],
  primary_row_by_device: {},
  discovery_status: { state: 'loading' as const, message: null },
});

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function normalizeText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) {
    return fallback;
  }

  const text = String(value).trim();
  return text.length > 0 ? text : fallback;
}

function firstNonEmptyText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = normalizeText(value, '');
    if (text) {
      return text;
    }
  }

  return null;
}

function toNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeDeviceRole(value: unknown): DeviceRole {
  const role = normalizeText(value, 'unknown')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (role === 'router' || role === 'switch' || role === 'bridge' || role === 'server') {
    return role;
  }

  return 'unknown';
}

function normalizeDeploymentType(value: unknown): DeploymentType {
  const deployment = normalizeText(value, 'unknown')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (deployment === 'physical' || deployment === 'virtual') {
    return deployment;
  }

  return 'unknown';
}

function normalizeDiscoveryState(value: unknown): DiscoveryState {
  const state = normalizeText(value, 'loading')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (
    state === 'loading' ||
    state === 'discovering' ||
    state === 'ready' ||
    state === 'failed'
  ) {
    return state;
  }

  return 'loading';
}

function normalizeIdentity(rawIdentity: unknown): IdentityKeys {
  const identity = asObject(rawIdentity);

  return {
    chassis_id: normalizeText(identity.chassis_id, '') || null,
    sys_name: normalizeText(identity.sys_name, '') || null,
    mgmt_ip: normalizeText(identity.mgmt_ip, '') || null,
    mac_addresses: Array.isArray(identity.mac_addresses)
      ? Array.from(
          new Set(
            identity.mac_addresses
              .map((value) => normalizeText(value, ''))
              .filter(Boolean)
          )
        )
      : [],
  };
}

function normalizeGuestAttachment(rawGuestAttachment: unknown): ViewGuestAttachment | null {
  const attachment = asObject(rawGuestAttachment);
  const bridgeName = normalizeText(attachment.bridge_name, '');
  if (!bridgeName) {
    return null;
  }

  const trunkVlans = Array.isArray(attachment.trunk_vlans)
    ? Array.from(
        new Set(
          attachment.trunk_vlans
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value >= 0)
        )
      ).sort((left, right) => left - right)
    : [];
  const vlanTagNumber = Number(attachment.vlan_tag);

  return {
    bridge_name: bridgeName,
    vlan_tag:
      attachment.vlan_tag === null ||
      attachment.vlan_tag === undefined ||
      !Number.isInteger(vlanTagNumber) ||
      vlanTagNumber < 0
        ? null
        : vlanTagNumber,
    trunk_vlans: trunkVlans,
  };
}

function normalizeDevice(rawDevice: unknown): ViewDevice {
  const device = asObject(rawDevice);
  const identityKeys = normalizeIdentity(device.identity_keys);

  return {
    id: normalizeText(device.id),
    label:
      firstNonEmptyText(
        device.label,
        device.sys_name,
        identityKeys.sys_name,
        device.name
      ) ?? 'Unknown',
    depth: Math.max(0, toNumber(device.depth, 0)),
    device_role: normalizeDeviceRole(device.device_role),
    deployment_type: normalizeDeploymentType(device.deployment_type),
    identity_keys: identityKeys,
    host_label: normalizeText(device.host_label, '') || null,
    upstream_interface: normalizeText(device.upstream_interface, '') || null,
  };
}

function normalizeLink(rawLink: unknown): ViewLink {
  const link = asObject(rawLink);

  return {
    id: normalizeText(
      link.id,
      [
        link.local_device_id,
        link.local_interface,
        link.remote_device_id,
        link.remote_interface,
        link.protocol,
      ]
        .map((part) => normalizeText(part, ''))
        .join('|')
    ),
    local_device_id: normalizeText(link.local_device_id),
    local_interface: normalizeText(link.local_interface, 'unknown'),
    local_ip: normalizeText(link.local_ip, '') || null,
    remote_device_id: normalizeText(link.remote_device_id),
    remote_interface: normalizeText(link.remote_interface, 'unknown'),
    remote_ip: normalizeText(link.remote_ip, '') || null,
    speed_bps:
      link.speed_bps === null || link.speed_bps === undefined
        ? null
        : Math.max(0, toNumber(link.speed_bps, 0)),
    protocol: normalizeText(link.protocol, 'lldp').toLowerCase(),
    guest_attachment: normalizeGuestAttachment(link.guest_attachment),
  };
}

function normalizeTreeRow(rawTreeRow: unknown): TreeRow {
  const row = asObject(rawTreeRow);
  return {
    id: normalizeText(row.id),
    device_id: normalizeText(row.device_id),
    label: normalizeText(row.label, 'Unknown'),
  };
}

function normalizeTreeEdge(rawTreeEdge: unknown): TreeEdge {
  const edge = asObject(rawTreeEdge);
  return {
    parent_row_id: normalizeText(edge.parent_row_id),
    child_row_id: normalizeText(edge.child_row_id),
  };
}

function normalizeDiscoveryStatus(rawStatus: unknown): DiscoveryStatus {
  if (typeof rawStatus === 'string') {
    return { state: normalizeDiscoveryState(rawStatus), message: null };
  }

  const status = asObject(rawStatus);
  return {
    state: normalizeDiscoveryState(
      status.state ?? status.kind ?? status.status ?? status.phase
    ),
    message:
      normalizeText(
        status.message ?? status.detail ?? status.error ?? status.reason,
        ''
      ) || null,
  };
}

export function decodeViewSnapshot(rawSnapshot: unknown): ViewSnapshot {
  const snapshot = asObject(rawSnapshot);

  return {
    devices: Array.isArray(snapshot.devices)
      ? snapshot.devices.map(normalizeDevice)
      : [],
    links: Array.isArray(snapshot.links) ? snapshot.links.map(normalizeLink) : [],
    tree_rows: Array.isArray(snapshot.tree_rows)
      ? snapshot.tree_rows.map(normalizeTreeRow)
      : [],
    tree_edges: Array.isArray(snapshot.tree_edges)
      ? snapshot.tree_edges.map(normalizeTreeEdge)
      : [],
    primary_row_by_device: Object.fromEntries(
      Object.entries(asObject(snapshot.primary_row_by_device))
        .map(([deviceId, rowId]) => [normalizeText(deviceId), normalizeText(rowId)])
        .filter(([deviceId, rowId]) => deviceId.length > 0 && rowId.length > 0)
    ),
    discovery_status: normalizeDiscoveryStatus(snapshot.discovery_status),
  };
}
