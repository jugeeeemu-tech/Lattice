import type {
  DiscoveryState,
  DiscoveryStatus,
  TreeEdge,
  TreeRow,
  ViewDevice,
  ViewLink,
  ViewSnapshot,
} from '../generated';

export const EMPTY_SNAPSHOT: ViewSnapshot = Object.freeze({
  devices: [],
  links: [],
  tree_rows: [],
  tree_edges: [],
  primary_row_by_device: {},
  root_device_ids: [],
  device_relations: {},
  discovery_status: { state: 'loading' as const },
  auto_discovery_interval_seconds: 60,
});

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asPositiveWholeNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.floor(value);
  return normalized >= 1 ? normalized : fallback;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asRecordOfStrings(value: unknown): Record<string, string> {
  const record = asObject(value);
  const entries = Object.entries(record).filter(
    (entry): entry is [string, string] =>
      entry[0].length > 0 && typeof entry[1] === 'string'
  );

  return Object.fromEntries(entries);
}

function asDeviceRelationsRecord(
  value: unknown
): Record<string, { parents: string[]; peers: string[]; children: string[] }> {
  const record = asObject(value);
  const entries = Object.entries(record).map(([deviceId, relations]) => {
    const decoded = asObject(relations);
    return [
      deviceId,
      {
        parents: asStringArray(decoded.parents),
        peers: asStringArray(decoded.peers),
        children: asStringArray(decoded.children),
      },
    ] as const;
  });
  return Object.fromEntries(entries);
}

function asStringArray(value: unknown): string[] {
  return asArray<unknown>(value).filter((entry): entry is string => typeof entry === 'string');
}

function asDiscoveryState(value: unknown): DiscoveryState {
  switch (value) {
    case 'loading':
    case 'discovering':
    case 'partial':
    case 'ready':
    case 'failed':
      return value;
    default:
      return EMPTY_SNAPSHOT.discovery_status.state;
  }
}

function decodeDiscoveryStatus(rawStatus: unknown): DiscoveryStatus {
  const status = asObject(rawStatus);

  return {
    state: asDiscoveryState(status.state),
    message: asOptionalString(status.message),
  };
}

export function decodeViewSnapshot(rawSnapshot: unknown): ViewSnapshot {
  if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) {
    return EMPTY_SNAPSHOT;
  }

  const snapshot = rawSnapshot as Record<string, unknown>;

  return {
    devices: asArray<ViewDevice>(snapshot.devices),
    links: asArray<Record<string, unknown>>(snapshot.links).map((link) => ({
      ...(link as ViewLink),
      network_cidrs: asStringArray(link.network_cidrs),
    })),
    tree_rows: asArray<TreeRow>(snapshot.tree_rows),
    tree_edges: asArray<TreeEdge>(snapshot.tree_edges),
    primary_row_by_device: asRecordOfStrings(snapshot.primary_row_by_device),
    root_device_ids: asStringArray(snapshot.root_device_ids),
    device_relations: asDeviceRelationsRecord(snapshot.device_relations),
    discovery_status: decodeDiscoveryStatus(snapshot.discovery_status),
    auto_discovery_interval_seconds: asPositiveWholeNumber(
      snapshot.auto_discovery_interval_seconds,
      EMPTY_SNAPSHOT.auto_discovery_interval_seconds
    ),
    next_auto_discovery_at_ms: asFiniteNumber(snapshot.next_auto_discovery_at_ms) ?? undefined,
  };
}
