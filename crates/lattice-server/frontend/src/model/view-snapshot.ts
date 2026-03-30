export type DiscoveryState = 'loading' | 'discovering' | 'ready' | 'failed';
export type DeviceRole = 'router' | 'switch' | 'bridge' | 'server' | 'unknown';
export type DeploymentType = 'physical' | 'virtual' | 'unknown';
export type GuestKind = 'vm' | 'container';

export interface DiscoveryStatus {
  state: DiscoveryState;
  message?: string | null;
}

export interface IdentityKeys {
  chassis_id?: string | null;
  sys_name?: string | null;
  mgmt_ip?: string | null;
  mac_addresses: string[];
}

export interface ViewDevice {
  id: string;
  label: string;
  depth: number;
  device_role: DeviceRole;
  deployment_type: DeploymentType;
  guest_kind: GuestKind | null;
  identity_keys: IdentityKeys;
  host_label?: string | null;
  upstream_interface?: string | null;
}

export interface ViewGuestAttachment {
  bridge_name: string;
  vlan_tag?: number | null;
  trunk_vlans: number[];
}

export interface ViewLink {
  id: string;
  local_device_id: string;
  local_interface: string;
  local_ip?: string | null;
  remote_device_id: string;
  remote_interface: string;
  remote_ip?: string | null;
  speed_bps?: number | null;
  protocol: string;
  guest_attachment?: ViewGuestAttachment | null;
}

export interface TreeRow {
  id: string;
  device_id: string;
  label: string;
}

export interface TreeEdge {
  parent_row_id: string;
  child_row_id: string;
}

export interface ViewSnapshot {
  devices: ViewDevice[];
  links: ViewLink[];
  tree_rows: TreeRow[];
  tree_edges: TreeEdge[];
  primary_row_by_device: Record<string, string>;
  discovery_status: DiscoveryStatus;
  auto_discovery_interval_seconds: number;
  next_auto_discovery_at_ms?: number | null;
}
