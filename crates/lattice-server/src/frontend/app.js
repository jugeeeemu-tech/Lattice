import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const STATUS_THEME = {
  loading: { bg: '#e0ecff', fg: '#0f3e98', label: 'loading' },
  discovering: { bg: '#fff1da', fg: '#9a4d00', label: 'discovering' },
  ready: { bg: '#def7ec', fg: '#0f766e', label: 'ready' },
  failed: { bg: '#fee2e2', fg: '#b42318', label: 'failed' },
};

const ROLE_LABELS = {
  router: 'Router',
  switch: 'Switch',
  bridge: 'Bridge',
  server: 'Server',
  unknown: 'Unknown',
};

const DEPLOYMENT_LABELS = {
  physical: 'Physical',
  virtual: 'Virtual',
  unknown: 'Unknown deployment',
};

const DEPLOYMENT_COLORS = {
  physical: 0x0f766e,
  virtual: 0xd97706,
  unknown: 0x627086,
};

const PROTOCOL_LABELS = {
  lldp: 'LLDP',
  proxmox_guest_link: 'Proxmox guest',
  proxmox_uplink: 'Proxmox uplink',
};

const EMPTY_SNAPSHOT = Object.freeze({
  devices: [],
  links: [],
  tree_rows: [],
  tree_edges: [],
  primary_row_by_device: {},
  discovery_status: { kind: 'loading', message: 'initializing' },
});

const SIDEBAR_MAIN_SECTION_ID = 'section:main';

const appRoot = document.getElementById('app');
const dom = {
  viewport: document.querySelector('.viewport'),
  sceneHost: document.getElementById('scene-host'),
  tree: document.getElementById('tree'),
  statusPill: document.querySelector('[data-role="status-pill"]'),
  statusMessage: document.querySelector('[data-role="status-message"]'),
  summary: document.querySelector('[data-role="summary"]'),
  emptyState: document.querySelector('[data-role="empty-state"]'),
  hoverCard: document.querySelector('[data-role="hover-card"]'),
  hoverTitle: document.querySelector('[data-role="hover-title"]'),
  hoverBody: document.querySelector('[data-role="hover-body"]'),
  discoverButton: document.querySelector('[data-action="discover"]'),
  reloadButton: document.querySelector('[data-action="reload"]'),
  showAllButton: document.querySelector('[data-action="show-all"]'),
};

if (!appRoot || !dom.viewport || !dom.sceneHost || !dom.tree) {
  throw new Error('Lattice frontend shell is missing required elements.');
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeText(value, fallback = '') {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text.length ? text : fallback;
}

function normalizeIdentity(identityKeys = {}) {
  const keys = asObject(identityKeys);
  const macAddresses = Array.isArray(keys.mac_addresses)
    ? keys.mac_addresses
        .map((value) => normalizeText(value, ''))
        .filter(Boolean)
    : [];

  return {
    chassis_id: normalizeText(keys.chassis_id, '') || null,
    sys_name: normalizeText(keys.sys_name, '') || null,
    mgmt_ip: normalizeText(keys.mgmt_ip, '') || null,
    mac_addresses: Array.from(new Set(macAddresses)),
  };
}

function normalizeDeviceRole(value) {
  const role = normalizeText(value, 'unknown')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (role === 'router' || role === 'switch' || role === 'bridge' || role === 'server') {
    return role;
  }
  return 'unknown';
}

function normalizeDeploymentType(value) {
  const deploymentType = normalizeText(value, 'unknown')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (deploymentType === 'physical' || deploymentType === 'virtual') {
    return deploymentType;
  }
  return 'unknown';
}

function normalizeDevice(device) {
  const entry = asObject(device);
  const identityKeys = normalizeIdentity(entry.identity_keys);
  return {
    id: normalizeText(entry.id),
    label: normalizeText(
      entry.label ?? entry.sys_name ?? identityKeys.sys_name ?? entry.name,
      'Unknown'
    ),
    depth: Math.max(0, toNumber(entry.depth, 0)),
    device_role: normalizeDeviceRole(entry.device_role),
    deployment_type: normalizeDeploymentType(entry.deployment_type),
    identity_keys: identityKeys,
    host_label: normalizeText(entry.host_label, '') || null,
    upstream_interface: normalizeText(entry.upstream_interface, '') || null,
  };
}

function normalizeLink(link) {
  const entry = asObject(link);
  const canonicalId = normalizeText(
    entry.id,
    [
      entry.local_device_id,
      entry.local_interface,
      entry.remote_device_id,
      entry.remote_interface,
      entry.protocol,
    ]
      .map((part) => normalizeText(part, ''))
      .join('|')
  );

  return {
    id: canonicalId,
    local_device_id: normalizeText(entry.local_device_id),
    local_interface: normalizeText(entry.local_interface, 'unknown'),
    local_ip: normalizeText(entry.local_ip, '') || null,
    remote_device_id: normalizeText(entry.remote_device_id),
    remote_interface: normalizeText(entry.remote_interface, 'unknown'),
    remote_ip: normalizeText(entry.remote_ip, '') || null,
    speed_bps:
      entry.speed_bps === null || entry.speed_bps === undefined
        ? null
        : Math.max(0, toNumber(entry.speed_bps, 0)),
    protocol: normalizeText(entry.protocol, 'lldp').toLowerCase(),
  };
}

function normalizeTreeRow(row) {
  const entry = asObject(row);
  return {
    id: normalizeText(entry.id),
    device_id: normalizeText(entry.device_id),
    label: normalizeText(entry.label, 'Unknown'),
  };
}

function normalizeTreeEdge(edge) {
  const entry = asObject(edge);
  return {
    parent_row_id: normalizeText(entry.parent_row_id),
    child_row_id: normalizeText(entry.child_row_id),
  };
}

function normalizeDiscoveryStatus(rawStatus) {
  const status = asObject(rawStatus);
  if (typeof rawStatus === 'string') {
    return { kind: rawStatus, message: '' };
  }

  const kind =
    normalizeText(status.kind || status.state || status.status || status.phase, 'loading').toLowerCase();
  const message = normalizeText(
    status.message || status.detail || status.error || status.reason,
    ''
  );

  return {
    kind,
    message,
  };
}

function normalizeSnapshot(rawSnapshot) {
  const snapshot = asObject(rawSnapshot);
  return {
    devices: Array.isArray(snapshot.devices) ? snapshot.devices.map(normalizeDevice) : [],
    links: Array.isArray(snapshot.links) ? snapshot.links.map(normalizeLink) : [],
    tree_rows: Array.isArray(snapshot.tree_rows) ? snapshot.tree_rows.map(normalizeTreeRow) : [],
    tree_edges: Array.isArray(snapshot.tree_edges) ? snapshot.tree_edges.map(normalizeTreeEdge) : [],
    primary_row_by_device: Object.fromEntries(
      Object.entries(asObject(snapshot.primary_row_by_device))
        .map(([key, value]) => [normalizeText(key), normalizeText(value)])
        .filter(([key, value]) => key && value)
    ),
    discovery_status: normalizeDiscoveryStatus(snapshot.discovery_status),
  };
}

function statusLabel(kind) {
  return STATUS_THEME[kind]?.label ?? kind ?? 'loading';
}

function hash01(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

function formatSpeed(speedBps) {
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

function compareByLabel(left, right) {
  const leftLabel = normalizeText(left?.label, 'Unknown').toLowerCase();
  const rightLabel = normalizeText(right?.label, 'Unknown').toLowerCase();
  if (leftLabel === rightLabel) {
    return normalizeText(left?.id).localeCompare(normalizeText(right?.id));
  }
  return leftLabel.localeCompare(rightLabel);
}

function findRowPath(rowId, parentByRowId) {
  const path = [];
  let current = rowId;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    path.unshift(current);
    current = parentByRowId.get(current) || null;
  }
  return path;
}

function roleLabel(role) {
  return ROLE_LABELS[role] || ROLE_LABELS.unknown;
}

function deploymentLabel(deploymentType) {
  return DEPLOYMENT_LABELS[deploymentType] || DEPLOYMENT_LABELS.unknown;
}

function deploymentColor(deploymentType) {
  return DEPLOYMENT_COLORS[deploymentType] || DEPLOYMENT_COLORS.unknown;
}

function protocolLabel(protocol) {
  return PROTOCOL_LABELS[protocol] || protocol;
}

class TopologyViewer {
  constructor(domNodes) {
    this.dom = domNodes;
    this.snapshot = normalizeSnapshot(EMPTY_SNAPSHOT);

    this.rowById = new Map();
    this.rowParentById = new Map();
    this.rowChildrenById = new Map();
    this.rowDepthById = new Map();
    this.rowIdsByDeviceId = new Map();
    this.primaryRowByDevice = new Map();
    this.primaryParentDeviceById = new Map();
    this.primaryChildrenByDeviceId = new Map();
    this.renderableDeviceIds = new Set();

    this.sidebarSections = [];
    this.sidebarEntryById = new Map();
    this.sidebarChildrenById = new Map();
    this.entryIdsByDeviceId = new Map();
    this.primaryEntryByDevice = new Map();
    this.treeEntryIdByRowId = new Map();

    this.hiddenDeviceIds = new Set();
    this.collapsedIds = new Set();

    this.sceneDeviceIds = new Set();
    this.deviceGroups = new Map();
    this.linkGroups = new Map();
    this.positionCache = new Map();

    this.hoveredEntryId = null;
    this.selectedEntryId = null;
    this.hoveredRowId = null;
    this.selectedRowId = null;
    this.hoveredDeviceId = null;
    this.selectedDeviceId = null;
    this.hoveredLinkId = null;
    this.hoverSource = null;
    this.hoverPointer = { x: 0, y: 0 };

    this.fetchInFlight = false;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.ws = null;
    this.wsReconnectDelay = 1000;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.deviceRoot = null;
    this.linkRoot = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.frameRequested = false;
    this.framedScene = false;

    this.treeBindingInstalled = false;
  }

  start() {
    this.installScene();
    this.installDomBindings();
    this.installActionButtons();
    this.installResizeObserver();
    this.applySnapshot(normalizeSnapshot(EMPTY_SNAPSHOT), { source: 'boot' });
    void this.refreshSnapshot({ quiet: true });
    this.connectWebSocket();
    this.startPolling();
    this.animate();
  }

  installActionButtons() {
    this.dom.discoverButton?.addEventListener('click', () => {
      void this.requestDiscovery();
    });

    this.dom.reloadButton?.addEventListener('click', () => {
      window.location.reload();
    });

    this.dom.showAllButton?.addEventListener('click', () => {
      if (!this.hiddenDeviceIds.size) {
        return;
      }
      this.hiddenDeviceIds.clear();
      this.refreshSceneVisibility();
      this.renderStatusStrip();
      this.renderTree();
      this.syncScene();
      this.syncSelectionAfterSnapshot();
      this.renderHoverCard();
    });
  }

  installDomBindings() {
    if (this.treeBindingInstalled) {
      return;
    }

    this.treeBindingInstalled = true;

    this.dom.tree.addEventListener('click', (event) => {
      const visibilityButton = event.target.closest('[data-role="visibility-toggle"]');
      if (visibilityButton) {
        event.preventDefault();
        event.stopPropagation();
        const deviceId = visibilityButton.getAttribute('data-device-id');
        if (deviceId) {
          this.toggleDeviceVisibility(deviceId);
        }
        return;
      }

      const sectionToggle = event.target.closest('[data-role="section-toggle"]');
      if (sectionToggle) {
        event.preventDefault();
        event.stopPropagation();
        const sectionId = sectionToggle.getAttribute('data-section-id');
        if (sectionId) {
          this.toggleCollapse(sectionId);
        }
        return;
      }

      const entryToggle = event.target.closest('[data-role="entry-toggle"]');
      if (entryToggle) {
        event.preventDefault();
        event.stopPropagation();
        const entryId = entryToggle.getAttribute('data-entry-id');
        if (entryId) {
          this.toggleCollapse(entryId);
        }
        return;
      }

      const entry = event.target.closest('[data-entry-id]');
      if (!entry) {
        return;
      }

      const entryId = entry.getAttribute('data-entry-id');
      if (!entryId) {
        return;
      }

      event.preventDefault();
      this.selectEntry(entryId, { reveal: true, source: 'tree' });
    });

    this.dom.tree.addEventListener('pointerover', (event) => {
      const entry = event.target.closest('[data-entry-id]');
      if (!entry) {
        return;
      }
      const entryId = entry.getAttribute('data-entry-id');
      if (!entryId) {
        return;
      }
      this.setEntryHover(entryId);
    });

    this.dom.tree.addEventListener('pointerleave', () => {
      if (this.hoverSource === 'tree') {
        this.clearHover();
      }
    });
  }

  installScene() {
    const { sceneHost } = this.dom;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf7f9fc);
    this.scene.fog = new THREE.Fog(0xf7f9fc, 24, 130);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
    this.camera.position.set(0, 18, 34);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0xf7f9fc, 1);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    sceneHost.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 220;
    this.controls.target.set(0, 0, 0);

    const ambient = new THREE.HemisphereLight(0xffffff, 0xe5ecf6, 2.2);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-20, 24, 18);
    const fill = new THREE.DirectionalLight(0xe5f0ff, 0.72);
    fill.position.set(18, -10, 12);

    this.scene.add(ambient, key, fill);

    const grid = new THREE.GridHelper(140, 56, 0xd8e1eb, 0xe9eef5);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -3;
    grid.material.transparent = true;
    grid.material.opacity = 0.24;
    this.scene.add(grid);

    this.deviceRoot = new THREE.Group();
    this.linkRoot = new THREE.Group();
    this.scene.add(this.linkRoot);
    this.scene.add(this.deviceRoot);

    this.renderer.domElement.addEventListener('pointermove', (event) => this.handlePointerMove(event));
    this.renderer.domElement.addEventListener('pointerleave', () => this.handlePointerLeave());
    this.renderer.domElement.addEventListener('click', (event) => this.handlePointerClick(event));
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  installResizeObserver() {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => this.resize());
    observer.observe(this.dom.viewport);
    this.resizeObserver = observer;
  }

  resize() {
    if (!this.renderer || !this.camera) {
      return;
    }

    const { width, height } = this.dom.viewport.getBoundingClientRect();
    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    this.renderer.setSize(safeWidth, safeHeight, false);
    this.camera.aspect = safeWidth / safeHeight;
    this.camera.updateProjectionMatrix();
  }

  async refreshSnapshot({ quiet = false } = {}) {
    if (this.fetchInFlight) {
      return false;
    }

    this.fetchInFlight = true;

    try {
      const response = await fetch('/api/topology', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      this.applySnapshot(normalizeSnapshot(payload), { source: 'http' });
      return true;
    } catch (error) {
      if (!quiet) {
        const message = error instanceof Error ? error.message : String(error);
        this.applyFailureState(`HTTP snapshot fetch failed: ${message}`);
      }
      return false;
    } finally {
      this.fetchInFlight = false;
    }
  }

  async requestDiscovery() {
    try {
      const response = await fetch('/api/discover', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await this.refreshSnapshot({ quiet: false });
      this.connectWebSocket(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.applyFailureState(`Discovery request failed: ${message}`);
    }
  }

  connectWebSocket(force = false) {
    if (typeof WebSocket === 'undefined') {
      return;
    }

    if (this.ws && !force && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (force && this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        // Ignore stale socket close failures.
      }
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/topology`);
    this.ws = socket;

    socket.addEventListener('open', () => {
      this.wsReconnectDelay = 1000;
      this.stopPolling();
      this.renderTransportNote('WebSocket connected');
    });

    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(event.data);
        this.applySnapshot(normalizeSnapshot(payload), { source: 'ws' });
      } catch (error) {
        // Ignore malformed frames and keep the last stable view.
      }
    });

    socket.addEventListener('close', () => {
      if (this.ws === socket) {
        this.ws = null;
      }
      this.renderTransportNote('WebSocket reconnecting');
      this.startPolling();
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      this.renderTransportNote('WebSocket error');
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
      this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 1.6, 8000);
    }, this.wsReconnectDelay);
  }

  startPolling() {
    if (this.pollTimer || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    const tick = async () => {
      this.pollTimer = null;

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        return;
      }

      await this.refreshSnapshot({ quiet: true });

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.pollTimer = window.setTimeout(tick, 1800);
      }
    };

    this.pollTimer = window.setTimeout(tick, 300);
  }

  stopPolling() {
    if (this.pollTimer) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  applySnapshot(snapshot, { source = 'http' } = {}) {
    this.snapshot = snapshot;
    this.refreshSnapshotModel();
    this.renderStatusStrip();
    this.renderTree();
    this.syncScene();
    this.syncSelectionAfterSnapshot();
    this.renderHoverCard();
    this.renderTransportNote(source === 'ws' ? 'Live snapshot received' : 'Snapshot loaded');
    this.updateViewportState();
  }

  applyFailureState(message) {
    this.snapshot = {
      ...(this.snapshot || EMPTY_SNAPSHOT),
      discovery_status: {
        kind: 'failed',
        message,
      },
    };
    this.renderStatusStrip();
    this.renderTransportNote(message);
    if (!this.sceneDeviceIds.size && !this.deviceGroups.size) {
      this.dom.emptyState.innerHTML = '';
      const card = document.createElement('div');
      card.className = 'empty-card';
      const title = document.createElement('p');
      title.className = 'empty-card__title';
      title.textContent = 'Discovery failed';
      const body = document.createElement('p');
      body.className = 'empty-card__body';
      body.textContent = message;
      card.append(title, body);
      this.dom.emptyState.appendChild(card);
    }
    this.updateViewportState();
  }

  refreshSnapshotModel() {
    this.buildRowModel();
    this.buildPrimaryDeviceTree();
    this.buildSidebarModel();
    this.pruneUiState();
    this.refreshSceneVisibility();
  }

  buildRowModel() {
    const rows = this.snapshot.tree_rows;
    const edges = this.snapshot.tree_edges;

    this.rowById = new Map(rows.map((row) => [row.id, row]));
    this.rowParentById = new Map();
    this.rowChildrenById = new Map(rows.map((row) => [row.id, []]));
    this.rowIdsByDeviceId = new Map();
    this.primaryRowByDevice = new Map(
      Object.entries(this.snapshot.primary_row_by_device).map(([deviceId, rowId]) => [deviceId, rowId])
    );

    for (const row of rows) {
      const list = this.rowIdsByDeviceId.get(row.device_id) || [];
      list.push(row.id);
      this.rowIdsByDeviceId.set(row.device_id, list);
    }

    for (const edge of edges) {
      if (!this.rowById.has(edge.parent_row_id) || !this.rowById.has(edge.child_row_id)) {
        continue;
      }
      this.rowParentById.set(edge.child_row_id, edge.parent_row_id);
      const children = this.rowChildrenById.get(edge.parent_row_id) || [];
      children.push(edge.child_row_id);
      this.rowChildrenById.set(edge.parent_row_id, children);
    }

    for (const [rowId, children] of this.rowChildrenById.entries()) {
      children.sort((left, right) => {
        const leftRow = this.rowById.get(left);
        const rightRow = this.rowById.get(right);
        return compareByLabel(leftRow, rightRow);
      });
      this.rowChildrenById.set(rowId, children);
    }

    for (const [deviceId, rowIds] of this.rowIdsByDeviceId.entries()) {
      rowIds.sort((left, right) => {
        const leftRow = this.rowById.get(left);
        const rightRow = this.rowById.get(right);
        return compareByLabel(leftRow, rightRow);
      });
      if (!this.primaryRowByDevice.get(deviceId) && rowIds.length) {
        this.primaryRowByDevice.set(deviceId, rowIds[0]);
      }
    }

    this.rowDepthById = new Map();
    const roots = rows
      .filter((row) => !this.rowParentById.has(row.id))
      .sort((left, right) => compareByLabel(left, right));

    const visited = new Set();
    const walk = (rowId, depth) => {
      if (visited.has(rowId)) {
        return;
      }
      visited.add(rowId);
      this.rowDepthById.set(rowId, depth);
      for (const childRowId of this.rowChildrenById.get(rowId) || []) {
        walk(childRowId, depth + 1);
      }
    };

    for (const root of roots) {
      walk(root.id, 0);
    }

    for (const row of rows) {
      if (!visited.has(row.id)) {
        walk(row.id, 0);
      }
    }

    this.renderableDeviceIds = rows.length
      ? new Set(rows.map((row) => row.device_id))
      : new Set(this.snapshot.devices.map((device) => device.id));
  }

  buildPrimaryDeviceTree() {
    this.primaryParentDeviceById = new Map();
    this.primaryChildrenByDeviceId = new Map(
      Array.from(this.renderableDeviceIds, (deviceId) => [deviceId, []])
    );

    for (const deviceId of this.renderableDeviceIds) {
      const rowId = this.primaryRowForDevice(deviceId);
      if (!rowId) {
        continue;
      }
      const parentRowId = this.rowParentById.get(rowId);
      if (!parentRowId) {
        continue;
      }
      const parentRow = this.rowById.get(parentRowId);
      if (!parentRow || parentRow.device_id === deviceId) {
        continue;
      }
      this.primaryParentDeviceById.set(deviceId, parentRow.device_id);
      const children = this.primaryChildrenByDeviceId.get(parentRow.device_id) || [];
      children.push(deviceId);
      this.primaryChildrenByDeviceId.set(parentRow.device_id, children);
    }

    for (const [deviceId, childIds] of this.primaryChildrenByDeviceId.entries()) {
      childIds.sort((leftId, rightId) => compareByLabel(this.findDevice(leftId), this.findDevice(rightId)));
      this.primaryChildrenByDeviceId.set(deviceId, childIds);
    }
  }

  buildSidebarModel() {
    this.sidebarSections = [];
    this.sidebarEntryById = new Map();
    this.sidebarChildrenById = new Map();
    this.entryIdsByDeviceId = new Map();
    this.primaryEntryByDevice = new Map();
    this.treeEntryIdByRowId = new Map();

    if (this.snapshot.tree_rows.length) {
      const roots = this.snapshot.tree_rows
        .filter((row) => !this.rowParentById.has(row.id))
        .sort((left, right) => compareByLabel(left, right));
      const entryIds = roots.map((row) => this.registerTreeEntry(row.id, null));
      this.sidebarSections.push({
        id: SIDEBAR_MAIN_SECTION_ID,
        label: '構成順',
        entry_ids: entryIds,
      });
    } else if (this.renderableDeviceIds.size) {
      const entryIds = this.snapshot.devices
        .filter((device) => this.renderableDeviceIds.has(device.id))
        .sort((left, right) => compareByLabel(left, right))
        .map((device) =>
          this.registerSidebarEntry({
            id: `flat:${device.id}`,
            device_id: device.id,
            label: device.label || 'Unknown',
            tree_row_id: this.primaryRowForDevice(device.id),
            source: 'flat',
            section_id: SIDEBAR_MAIN_SECTION_ID,
            host_label: device.host_label,
          })
        );
      this.sidebarSections.push({
        id: SIDEBAR_MAIN_SECTION_ID,
        label: '構成順',
        entry_ids: entryIds,
      });
    }

    const devicesByHost = new Map();
    for (const device of this.snapshot.devices) {
      if (!this.renderableDeviceIds.has(device.id) || !device.host_label) {
        continue;
      }
      const list = devicesByHost.get(device.host_label) || [];
      list.push(device);
      devicesByHost.set(device.host_label, list);
    }

    for (const hostLabel of Array.from(devicesByHost.keys()).sort((left, right) => left.localeCompare(right))) {
      const sectionId = `section:host:${hostLabel}`;
      const entryIds = devicesByHost
        .get(hostLabel)
        .slice()
        .sort((left, right) => compareByLabel(left, right))
        .map((device) =>
          this.registerSidebarEntry({
            id: `host:${hostLabel}:${device.id}`,
            device_id: device.id,
            label: device.label || 'Unknown',
            tree_row_id: this.primaryRowForDevice(device.id),
            source: 'host',
            section_id: sectionId,
            host_label: hostLabel,
          })
        );

      this.sidebarSections.push({
        id: sectionId,
        label: `${hostLabel} 上`,
        entry_ids: entryIds,
      });
    }

    for (const section of this.sidebarSections) {
      if (!section.entry_ids.length) {
        continue;
      }
      for (const entryId of section.entry_ids) {
        const entry = this.sidebarEntryById.get(entryId);
        if (!entry || this.primaryEntryByDevice.has(entry.device_id)) {
          continue;
        }
        this.primaryEntryByDevice.set(entry.device_id, entryId);
      }
    }
  }

  registerTreeEntry(rowId, parentEntryId) {
    const row = this.rowById.get(rowId);
    if (!row) {
      return null;
    }

    const entryId = `tree:${row.id}`;
    const entry = {
      id: entryId,
      device_id: row.device_id,
      label: row.label || this.findDevice(row.device_id)?.label || 'Unknown',
      tree_row_id: row.id,
      source: 'tree',
      section_id: SIDEBAR_MAIN_SECTION_ID,
      host_label: this.findDevice(row.device_id)?.host_label || null,
    };

    this.registerSidebarEntry(entry, parentEntryId);
    this.treeEntryIdByRowId.set(row.id, entryId);

    const childEntryIds = [];
    for (const childRowId of this.rowChildrenById.get(row.id) || []) {
      const childEntryId = this.registerTreeEntry(childRowId, entryId);
      if (childEntryId) {
        childEntryIds.push(childEntryId);
      }
    }
    this.sidebarChildrenById.set(entryId, childEntryIds);
    return entryId;
  }

  registerSidebarEntry(entry, parentEntryId = null) {
    this.sidebarEntryById.set(entry.id, entry);

    const entryIds = this.entryIdsByDeviceId.get(entry.device_id) || [];
    entryIds.push(entry.id);
    this.entryIdsByDeviceId.set(entry.device_id, entryIds);

    if (parentEntryId) {
      const childIds = this.sidebarChildrenById.get(parentEntryId) || [];
      childIds.push(entry.id);
      this.sidebarChildrenById.set(parentEntryId, childIds);
    }

    if (!this.sidebarChildrenById.has(entry.id)) {
      this.sidebarChildrenById.set(entry.id, []);
    }

    return entry.id;
  }

  pruneUiState() {
    const validCollapsedIds = new Set([
      ...this.sidebarSections.map((section) => section.id),
      ...Array.from(this.sidebarChildrenById.entries())
        .filter(([, childIds]) => childIds.length)
        .map(([entryId]) => entryId),
    ]);

    for (const id of Array.from(this.collapsedIds)) {
      if (!validCollapsedIds.has(id)) {
        this.collapsedIds.delete(id);
      }
    }

    const validDeviceIds = this.renderableDeviceIds;
    for (const deviceId of Array.from(this.hiddenDeviceIds)) {
      if (!validDeviceIds.has(deviceId)) {
        this.hiddenDeviceIds.delete(deviceId);
      }
    }

    if (this.selectedDeviceId && !validDeviceIds.has(this.selectedDeviceId)) {
      this.selectedDeviceId = null;
      this.selectedEntryId = null;
      this.selectedRowId = null;
    } else if (this.selectedDeviceId) {
      const entryIds = this.entryIdsByDeviceId.get(this.selectedDeviceId) || [];
      if (!entryIds.includes(this.selectedEntryId)) {
        this.selectedEntryId = this.primaryEntryByDevice.get(this.selectedDeviceId) || entryIds[0] || null;
      }
      this.selectedRowId =
        this.sidebarEntryById.get(this.selectedEntryId)?.tree_row_id ||
        this.primaryRowForDevice(this.selectedDeviceId) ||
        null;
    }

    if (this.hoveredDeviceId && !validDeviceIds.has(this.hoveredDeviceId)) {
      this.hoveredDeviceId = null;
      this.hoveredEntryId = null;
      this.hoveredRowId = null;
      this.hoveredLinkId = null;
      this.hoverSource = null;
    } else if (this.hoveredDeviceId) {
      const entryIds = this.entryIdsByDeviceId.get(this.hoveredDeviceId) || [];
      if (this.hoveredEntryId && !entryIds.includes(this.hoveredEntryId)) {
        this.hoveredEntryId = null;
      }
      this.hoveredRowId =
        this.sidebarEntryById.get(this.hoveredEntryId)?.tree_row_id ||
        this.primaryRowForDevice(this.hoveredDeviceId) ||
        null;
    }

    if (this.hoveredLinkId && !this.snapshot.links.some((link) => link.id === this.hoveredLinkId)) {
      this.hoveredLinkId = null;
    }
  }

  refreshSceneVisibility() {
    this.sceneDeviceIds = new Set(
      Array.from(this.renderableDeviceIds).filter((deviceId) => !this.hiddenDeviceIds.has(deviceId))
    );
  }

  renderStatusStrip() {
    const status = this.snapshot.discovery_status || { kind: 'loading', message: '' };
    const theme = STATUS_THEME[status.kind] || STATUS_THEME.loading;

    this.dom.statusPill.textContent = statusLabel(status.kind);
    this.dom.statusPill.style.background = theme.bg;
    this.dom.statusPill.style.color = theme.fg;
    this.dom.statusPill.dataset.status = status.kind;

    const message =
      status.message ||
      ({
        loading: '初回探索を待機中',
        discovering: '前回の構成を維持したまま更新中',
        ready: '最新の構成を表示中',
        failed: '前回の構成を維持しています',
      }[status.kind] || '状態を取得中');

    this.dom.statusMessage.textContent = message;
    this.dom.summary.textContent = `${this.renderableDeviceIds.size} scene devices / ${this.snapshot.links.length} links`;

    if (this.dom.discoverButton) {
      const isDiscovering = status.kind === 'discovering';
      this.dom.discoverButton.disabled = isDiscovering;
      this.dom.discoverButton.textContent = isDiscovering ? '探索中' : '再探索';
    }

    if (this.dom.showAllButton) {
      const hiddenCount = this.hiddenDeviceIds.size;
      this.dom.showAllButton.hidden = hiddenCount === 0;
      this.dom.showAllButton.textContent = hiddenCount > 0 ? `すべて表示 (${hiddenCount})` : 'すべて表示';
    }
  }

  renderTree() {
    const fragment = document.createDocumentFragment();
    let renderedEntryCount = 0;

    for (const section of this.sidebarSections) {
      if (!section.entry_ids.length) {
        continue;
      }

      const wrapper = document.createElement('section');
      wrapper.className = 'tree-section';

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'tree-section__header';
      header.dataset.role = 'section-toggle';
      header.dataset.sectionId = section.id;

      const toggle = document.createElement('span');
      toggle.className = 'tree-toggle';
      if (!this.collapsedIds.has(section.id)) {
        toggle.classList.add('is-open');
      }

      const title = document.createElement('span');
      title.className = 'tree-section__title';
      title.textContent = section.label;

      const count = document.createElement('span');
      count.className = 'tree-section__count';
      count.textContent = `${this.countSectionEntries(section.entry_ids)}`;

      header.append(toggle, title, count);
      wrapper.append(header);

      if (!this.collapsedIds.has(section.id)) {
        const body = document.createElement('div');
        body.className = 'tree-section__body';
        for (const entryId of section.entry_ids) {
          renderedEntryCount += this.appendSidebarEntry(entryId, 0, body);
        }
        wrapper.append(body);
      }

      fragment.append(wrapper);
    }

    this.dom.tree.replaceChildren(fragment);

    if (!renderedEntryCount) {
      const empty = document.createElement('div');
      empty.className = 'tree__empty';
      empty.textContent = '表示できる構成を待っています。';
      this.dom.tree.replaceChildren(empty);
    }

    this.applyTreeHighlights();
  }

  appendSidebarEntry(entryId, depth, container) {
    const entry = this.sidebarEntryById.get(entryId);
    const device = entry ? this.findDevice(entry.device_id) : null;
    if (!entry || !device) {
      return 0;
    }

    let renderedCount = 1;
    const childIds = this.sidebarChildrenById.get(entry.id) || [];
    const hasChildren = childIds.length > 0;
    const expanded = !this.collapsedIds.has(entry.id);

    const rowEl = document.createElement('div');
    rowEl.className = 'tree-row';
    rowEl.dataset.entryId = entry.id;
    rowEl.dataset.deviceId = entry.device_id;
    rowEl.setAttribute('role', 'treeitem');
    rowEl.style.paddingInlineStart = `${0.4 + depth * 1.05}rem`;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle';
    toggle.dataset.role = 'entry-toggle';
    toggle.dataset.entryId = entry.id;
    toggle.setAttribute('aria-label', hasChildren ? (expanded ? '折りたたむ' : '展開する') : 'leaf');
    if (hasChildren) {
      if (expanded) {
        toggle.classList.add('is-open');
      }
    } else {
      toggle.classList.add('tree-toggle--leaf');
    }

    const labelButton = document.createElement('button');
    labelButton.type = 'button';
    labelButton.className = 'tree-row__label';

    const mark = document.createElement('span');
    mark.className = 'tree-row__mark';
    mark.dataset.roleKind = device.device_role;
    mark.dataset.deployment = device.deployment_type;

    const copy = document.createElement('div');
    copy.className = 'tree-row__copy';

    const name = document.createElement('span');
    name.className = 'tree-row__name';
    name.textContent = entry.label || device.label || 'Unknown';

    const meta = document.createElement('span');
    meta.className = 'tree-row__meta';
    meta.textContent = this.entryMetaText(entry);

    copy.append(name, meta);
    labelButton.append(mark, copy);

    const visibilityButton = document.createElement('button');
    visibilityButton.type = 'button';
    visibilityButton.className = 'tree-row__visibility';
    visibilityButton.dataset.role = 'visibility-toggle';
    visibilityButton.dataset.deviceId = entry.device_id;
    const hidden = this.hiddenDeviceIds.has(entry.device_id);
    if (hidden) {
      visibilityButton.classList.add('is-hidden');
    }
    visibilityButton.textContent = hidden ? '表示' : '隠す';

    rowEl.append(toggle, labelButton, visibilityButton);
    container.append(rowEl);

    if (hasChildren && expanded) {
      for (const childEntryId of childIds) {
        renderedCount += this.appendSidebarEntry(childEntryId, depth + 1, container);
      }
    }

    return renderedCount;
  }

  countSectionEntries(entryIds) {
    let count = 0;
    const stack = [...entryIds];
    while (stack.length) {
      const entryId = stack.pop();
      if (!entryId || !this.sidebarEntryById.has(entryId)) {
        continue;
      }
      count += 1;
      for (const childId of this.sidebarChildrenById.get(entryId) || []) {
        stack.push(childId);
      }
    }
    return count;
  }

  entryMetaText(entry) {
    const entryIds = this.entryIdsByDeviceId.get(entry.device_id) || [];
    if (this.selectedDeviceId === entry.device_id && this.selectedEntryId && this.selectedEntryId !== entry.id && entryIds.length > 1) {
      return '同じ機器';
    }
    if (this.hiddenDeviceIds.has(entry.device_id)) {
      return '非表示';
    }
    if (entry.source === 'host') {
      return '別入口';
    }
    return '';
  }

  applyTreeHighlights() {
    const selectedPathEntryIds = this.pathEntryIdsForRow(this.selectedRowId);
    const hoveredPathEntryIds = this.pathEntryIdsForRow(this.hoveredRowId);
    const selectedEntryPeers = new Set(this.entryIdsByDeviceId.get(this.selectedDeviceId) || []);
    const hoveredEntryPeers = new Set(this.entryIdsByDeviceId.get(this.hoveredDeviceId) || []);

    for (const rowEl of this.dom.tree.querySelectorAll('[data-entry-id]')) {
      const entryId = rowEl.getAttribute('data-entry-id');
      const deviceId = rowEl.getAttribute('data-device-id');
      const isSelected = entryId === this.selectedEntryId;
      const isHovered =
        entryId === this.hoveredEntryId ||
        hoveredPathEntryIds.has(entryId) ||
        (this.hoverSource === 'scene' && hoveredEntryPeers.has(entryId));
      const isAncestor = selectedPathEntryIds.has(entryId) && !isSelected;
      const isPeer = selectedEntryPeers.has(entryId) && !isSelected;
      const isHidden = this.hiddenDeviceIds.has(deviceId);

      rowEl.classList.toggle('is-selected', isSelected);
      rowEl.classList.toggle('is-hovered', isHovered);
      rowEl.classList.toggle('is-ancestor', isAncestor);
      rowEl.classList.toggle('is-peer', isPeer);
      rowEl.classList.toggle('is-hidden', isHidden);
    }
  }

  toggleCollapse(id) {
    if (this.collapsedIds.has(id)) {
      this.collapsedIds.delete(id);
    } else {
      this.collapsedIds.add(id);
    }

    this.renderTree();
    this.syncScene();
    this.syncSelectionAfterSnapshot();
  }

  toggleDeviceVisibility(deviceId) {
    if (!this.renderableDeviceIds.has(deviceId)) {
      return;
    }

    if (this.hiddenDeviceIds.has(deviceId)) {
      this.hiddenDeviceIds.delete(deviceId);
    } else {
      this.hiddenDeviceIds.add(deviceId);
    }

    this.refreshSceneVisibility();
    this.renderStatusStrip();
    this.renderTree();
    this.syncScene();
    this.syncSelectionAfterSnapshot();
    this.renderHoverCard();
  }

  selectEntry(entryId, { reveal = false, source = 'tree' } = {}) {
    const entry = this.sidebarEntryById.get(entryId);
    if (!entry) {
      return;
    }

    this.hiddenDeviceIds.delete(entry.device_id);
    this.refreshSceneVisibility();

    this.selectedEntryId = entry.id;
    this.selectedDeviceId = entry.device_id;
    this.selectedRowId = entry.tree_row_id || this.primaryRowForDevice(entry.device_id) || null;

    this.hoverSource = source;
    this.hoveredEntryId = entry.id;
    this.hoveredDeviceId = entry.device_id;
    this.hoveredRowId = this.selectedRowId;
    this.hoveredLinkId = null;

    if (reveal) {
      this.revealEntry(entry.id);
    }

    this.renderStatusStrip();
    this.renderTree();
    this.syncScene();
    this.syncSelectionAfterSnapshot();
    this.scrollEntryIntoView(entry.id);
  }

  revealEntry(entryId) {
    const entry = this.sidebarEntryById.get(entryId);
    if (!entry) {
      return;
    }

    if (entry.section_id) {
      this.collapsedIds.delete(entry.section_id);
    }

    if (entry.tree_row_id) {
      for (const rowId of findRowPath(entry.tree_row_id, this.rowParentById)) {
        const pathEntryId = this.treeEntryIdByRowId.get(rowId);
        if (pathEntryId) {
          this.collapsedIds.delete(pathEntryId);
        }
      }
      this.collapsedIds.delete(SIDEBAR_MAIN_SECTION_ID);
    }
  }

  setEntryHover(entryId) {
    const entry = this.sidebarEntryById.get(entryId);
    if (!entry) {
      return;
    }

    this.hoverSource = 'tree';
    this.hoveredEntryId = entry.id;
    this.hoveredDeviceId = entry.device_id;
    this.hoveredRowId = entry.tree_row_id || this.primaryRowForDevice(entry.device_id) || null;
    this.hoveredLinkId = null;
    this.renderHoverCard();
    this.applyTreeHighlights();
    this.updateObjectStyles();
  }

  setDeviceHover(deviceId, linkId = null) {
    if (!deviceId && !linkId) {
      return;
    }
    this.hoverSource = 'scene';
    this.hoveredDeviceId = deviceId;
    this.hoveredLinkId = linkId;
    this.hoveredEntryId = deviceId ? this.primaryEntryByDevice.get(deviceId) || null : null;
    this.hoveredRowId = deviceId ? this.primaryRowForDevice(deviceId) : null;
    this.renderHoverCard();
    this.applyTreeHighlights();
    this.updateObjectStyles();
  }

  clearHover() {
    this.hoverSource = null;
    this.hoveredEntryId = null;
    this.hoveredRowId = null;
    this.hoveredDeviceId = null;
    this.hoveredLinkId = null;
    this.renderHoverCard();
    this.applyTreeHighlights();
    this.updateObjectStyles();
  }

  scrollEntryIntoView(entryId) {
    const entryElement = this.dom.tree.querySelector(`[data-entry-id="${CSS.escape(entryId)}"]`);
    if (entryElement) {
      entryElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  syncSelectionAfterSnapshot() {
    if (this.selectedDeviceId && !this.sceneDeviceIds.has(this.selectedDeviceId) && !this.hiddenDeviceIds.has(this.selectedDeviceId)) {
      this.selectedDeviceId = null;
      this.selectedEntryId = null;
      this.selectedRowId = null;
    }

    if (this.selectedDeviceId) {
      const entryIds = this.entryIdsByDeviceId.get(this.selectedDeviceId) || [];
      if (!entryIds.includes(this.selectedEntryId)) {
        this.selectedEntryId = this.primaryEntryByDevice.get(this.selectedDeviceId) || entryIds[0] || null;
      }
      this.selectedRowId =
        this.sidebarEntryById.get(this.selectedEntryId)?.tree_row_id ||
        this.primaryRowForDevice(this.selectedDeviceId) ||
        null;
    }

    if (this.hoveredDeviceId) {
      const entryIds = this.entryIdsByDeviceId.get(this.hoveredDeviceId) || [];
      if (this.hoveredEntryId && !entryIds.includes(this.hoveredEntryId)) {
        this.hoveredEntryId = null;
      }
      this.hoveredRowId =
        this.sidebarEntryById.get(this.hoveredEntryId)?.tree_row_id ||
        this.primaryRowForDevice(this.hoveredDeviceId) ||
        null;
    }

    this.applyTreeHighlights();
    this.updateObjectStyles();
    this.renderHoverCard();
  }

  updateEmptyState() {
    const hasVisibleTopology = this.sceneDeviceIds.size > 0;
    this.dom.viewport.classList.toggle('is-ready', hasVisibleTopology);

    if (hasVisibleTopology) {
      this.dom.emptyState.innerHTML = '';
      return;
    }

    const hiddenAll = this.renderableDeviceIds.size > 0 && this.hiddenDeviceIds.size >= this.renderableDeviceIds.size;
    const status = this.snapshot.discovery_status || { kind: 'loading', message: '' };

    const titleByStatus = {
      loading: 'Topology is warming up',
      discovering: 'Discovery is running',
      failed: 'Discovery failed',
      ready: 'No devices to render',
    };

    const bodyByStatus = {
      loading: '初回探索が完了すると、3D ビューと操作ペインが表示されます。',
      discovering: '最新の構成を組み立てています。完了後に自動で切り替わります。',
      failed: status.message || '探索に失敗しました。旧構成があればそのまま保持しています。',
      ready: '可視化できる機器がありません。',
    };

    this.dom.emptyState.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'empty-card';
    const title = document.createElement('p');
    title.className = 'empty-card__title';
    title.textContent = hiddenAll ? 'すべて非表示です' : titleByStatus[status.kind] || titleByStatus.loading;
    const body = document.createElement('p');
    body.className = 'empty-card__body';
    body.textContent = hiddenAll
      ? '左ペインの「表示」または「すべて表示」で scene に戻せます。'
      : bodyByStatus[status.kind] || bodyByStatus.loading;
    card.append(title, body);
    this.dom.emptyState.appendChild(card);
  }

  renderTransportNote(text) {
    this.dom.statusMessage.dataset.transport = text;
    this.dom.statusMessage.title = text;
  }

  findDevice(deviceId) {
    return this.snapshot.devices.find((candidate) => candidate.id === deviceId) || null;
  }

  primaryRowForDevice(deviceId) {
    return this.primaryRowByDevice.get(deviceId) || (this.rowIdsByDeviceId.get(deviceId) || [null])[0] || null;
  }

  pathEntryIdsForRow(rowId) {
    const entryIds = new Set();
    if (!rowId) {
      return entryIds;
    }
    for (const pathRowId of findRowPath(rowId, this.rowParentById)) {
      const entryId = this.treeEntryIdByRowId.get(pathRowId);
      if (entryId) {
        entryIds.add(entryId);
      }
    }
    return entryIds;
  }

  pathDeviceIdsForRow(rowId) {
    const deviceIds = new Set();
    if (!rowId) {
      return deviceIds;
    }
    for (const pathRowId of findRowPath(rowId, this.rowParentById)) {
      const row = this.rowById.get(pathRowId);
      if (row?.device_id) {
        deviceIds.add(row.device_id);
      }
    }
    return deviceIds;
  }

  pathLinkIdsForRow(rowId) {
    const linkIds = new Set();
    if (!rowId) {
      return linkIds;
    }

    const path = findRowPath(rowId, this.rowParentById);
    for (let index = 1; index < path.length; index += 1) {
      const parentDeviceId = this.rowById.get(path[index - 1])?.device_id;
      const childDeviceId = this.rowById.get(path[index])?.device_id;
      if (!parentDeviceId || !childDeviceId || parentDeviceId === childDeviceId) {
        continue;
      }
      const link = this.findPreferredPathLink(parentDeviceId, childDeviceId);
      if (link) {
        linkIds.add(link.id);
      }
    }
    return linkIds;
  }

  findPreferredPathLink(parentDeviceId, childDeviceId) {
    const childDevice = this.findDevice(childDeviceId);
    const matches = this.snapshot.links.filter((link) => {
      return (
        (link.local_device_id === parentDeviceId && link.remote_device_id === childDeviceId) ||
        (link.local_device_id === childDeviceId && link.remote_device_id === parentDeviceId)
      );
    });

    if (!matches.length) {
      return null;
    }

    if (childDevice?.upstream_interface) {
      const upstreamMatches = matches.filter(
        (link) => this.interfaceForDevice(link, childDeviceId) === childDevice.upstream_interface
      );
      if (upstreamMatches.length === 1) {
        return upstreamMatches[0];
      }
      if (upstreamMatches.length > 1) {
        return upstreamMatches.sort((left, right) => left.id.localeCompare(right.id))[0];
      }
    }

    const proxmoxMatch = matches.find((link) => link.protocol === 'proxmox_guest_link');
    if (proxmoxMatch) {
      return proxmoxMatch;
    }

    const uplinkMatch = matches.find((link) => link.protocol === 'proxmox_uplink');
    if (uplinkMatch) {
      return uplinkMatch;
    }

    return matches.slice().sort((left, right) => left.id.localeCompare(right.id))[0];
  }

  interfaceForDevice(link, deviceId) {
    if (link.local_device_id === deviceId) {
      return link.local_interface;
    }
    if (link.remote_device_id === deviceId) {
      return link.remote_interface;
    }
    return null;
  }

  deviceSummary(device) {
    const details = [roleLabel(device.device_role)];
    if (device.deployment_type !== 'unknown') {
      details.push(deploymentLabel(device.deployment_type));
    }
    if (device.host_label) {
      details.push(`${device.host_label} 上`);
    }
    return details;
  }

  renderHoverCard() {
    if (this.hoverSource === 'tree' && this.hoveredEntryId) {
      const entry = this.sidebarEntryById.get(this.hoveredEntryId);
      if (entry) {
        this.renderHoverCardForEntry(entry);
        return;
      }
    }

    if (this.hoveredLinkId) {
      const link = this.snapshot.links.find((candidate) => candidate.id === this.hoveredLinkId);
      if (link) {
        this.renderHoverCardForLink(link);
        return;
      }
    }

    if (this.hoveredDeviceId) {
      const device = this.findDevice(this.hoveredDeviceId);
      if (device) {
        this.renderHoverCardForDevice(device);
        return;
      }
    }

    this.dom.hoverCard.hidden = true;
  }

  renderHoverCardForEntry(entry) {
    const device = this.findDevice(entry.device_id);
    if (!device) {
      this.dom.hoverCard.hidden = true;
      return;
    }

    this.dom.hoverCard.hidden = false;
    this.dom.hoverTitle.textContent = entry.label || device.label || 'Unknown';
    this.dom.hoverBody.textContent = this.deviceSummary(device).join(' · ');
    this.positionHoverCard(this.dom.hoverCard, 20, 20);
  }

  renderHoverCardForDevice(device) {
    this.dom.hoverCard.hidden = false;
    this.dom.hoverTitle.textContent = device.label || device.identity_keys.sys_name || 'Unknown';
    this.dom.hoverBody.textContent = this.deviceSummary(device).join(' · ');
    this.positionHoverCard(this.dom.hoverCard, this.hoverPointer.x + 18, this.hoverPointer.y + 18);
  }

  renderHoverCardForLink(link) {
    const local = this.findDevice(link.local_device_id);
    const remote = this.findDevice(link.remote_device_id);
    this.dom.hoverCard.hidden = false;
    this.dom.hoverTitle.textContent = `${local?.label || link.local_interface} ↔ ${remote?.label || link.remote_interface}`;
    const details = [
      `${link.local_interface}${link.local_ip ? ` · ${link.local_ip}` : ''}`,
      `${link.remote_interface}${link.remote_ip ? ` · ${link.remote_ip}` : ''}`,
      formatSpeed(link.speed_bps),
      protocolLabel(link.protocol),
    ].filter(Boolean);
    this.dom.hoverBody.textContent = details.join(' · ');
    this.positionHoverCard(this.dom.hoverCard, this.hoverPointer.x + 18, this.hoverPointer.y + 18);
  }

  positionHoverCard(card, x, y) {
    const bounds = this.dom.viewport.getBoundingClientRect();
    const maxX = Math.max(16, bounds.width - 340);
    const maxY = Math.max(16, bounds.height - 160);
    const clampedX = Math.max(16, Math.min(x, maxX));
    const clampedY = Math.max(16, Math.min(y, maxY));
    card.style.left = `${clampedX}px`;
    card.style.top = `${clampedY}px`;
  }

  syncScene() {
    const visibleDevices = this.snapshot.devices.filter((device) => this.sceneDeviceIds.has(device.id));
    const targetByDeviceId = this.computeTargets(visibleDevices);
    const visibleDeviceSet = new Set(visibleDevices.map((device) => device.id));

    if (!this.framedScene && visibleDevices.length) {
      const centroid = this.computeCentroid(targetByDeviceId);
      const bounds = this.computeBounds(targetByDeviceId);
      const span = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, 18);
      this.controls.target.copy(centroid);
      this.camera.position.set(centroid.x, centroid.y + 12, centroid.z + Math.max(30, span * 1.2));
      this.camera.lookAt(centroid);
      this.framedScene = true;
    }

    for (const device of visibleDevices) {
      const target = targetByDeviceId.get(device.id) || new THREE.Vector3();
      const existing = this.deviceGroups.get(device.id);
      if (!existing) {
        const group = this.createDeviceGroup(device);
        const start = this.positionCache.get(device.id) || target.clone();
        group.position.copy(start);
        group.userData.target.copy(target);
        this.deviceGroups.set(device.id, group);
        this.deviceRoot.add(group);
      } else {
        existing.userData.device = device;
        existing.userData.target.copy(target);
      }
    }

    for (const [deviceId, group] of Array.from(this.deviceGroups.entries())) {
      if (!visibleDeviceSet.has(deviceId)) {
        this.positionCache.set(deviceId, group.position.clone());
        this.deviceRoot.remove(group);
        this.deviceGroups.delete(deviceId);
      }
    }

    const visibleLinks = this.snapshot.links.filter(
      (link) => visibleDeviceSet.has(link.local_device_id) && visibleDeviceSet.has(link.remote_device_id)
    );
    const visibleLinkIds = new Set(visibleLinks.map((link) => link.id));

    for (const link of visibleLinks) {
      let group = this.linkGroups.get(link.id);
      if (!group) {
        group = this.createLinkGroup(link);
        this.linkGroups.set(link.id, group);
        this.linkRoot.add(group);
      }
      group.userData.link = link;
    }

    for (const [linkId, group] of Array.from(this.linkGroups.entries())) {
      if (!visibleLinkIds.has(linkId)) {
        this.linkRoot.remove(group);
        this.linkGroups.delete(linkId);
      }
    }

    this.updateObjectStyles();
    this.updateEmptyState();
  }

  computeTargets(devices) {
    if (!devices.length) {
      return new Map();
    }

    const visibleIds = new Set(devices.map((device) => device.id));
    const childrenByDeviceId = new Map(Array.from(visibleIds, (deviceId) => [deviceId, []]));
    const roots = [];

    for (const device of devices) {
      const parentId = this.primaryParentDeviceById.get(device.id);
      if (parentId && visibleIds.has(parentId)) {
        const children = childrenByDeviceId.get(parentId) || [];
        children.push(device.id);
        childrenByDeviceId.set(parentId, children);
      } else {
        roots.push(device.id);
      }
    }

    for (const [deviceId, childIds] of childrenByDeviceId.entries()) {
      childIds.sort((leftId, rightId) => compareByLabel(this.findDevice(leftId), this.findDevice(rightId)));
      childrenByDeviceId.set(deviceId, childIds);
    }
    roots.sort((leftId, rightId) => compareByLabel(this.findDevice(leftId), this.findDevice(rightId)));

    const widthCache = new Map();
    const branchGap = 0.42;
    const xSpacing = 6.4;
    const ySpacing = 7.8;

    const subtreeWidth = (deviceId) => {
      if (widthCache.has(deviceId)) {
        return widthCache.get(deviceId);
      }
      const childIds = childrenByDeviceId.get(deviceId) || [];
      if (!childIds.length) {
        widthCache.set(deviceId, 1);
        return 1;
      }
      const totalWidth =
        childIds.reduce((sum, childId) => sum + subtreeWidth(childId), 0) +
        Math.max(0, childIds.length - 1) * branchGap;
      widthCache.set(deviceId, totalWidth);
      return totalWidth;
    };

    const totalWidth =
      roots.reduce((sum, deviceId) => sum + subtreeWidth(deviceId), 0) +
      Math.max(0, roots.length - 1) * 1.2;
    const targetByDeviceId = new Map();

    const place = (deviceId, left, depth) => {
      const width = subtreeWidth(deviceId);
      const center = left + width / 2;
      const device = this.findDevice(deviceId);
      const deploymentOffset =
        device?.deployment_type === 'virtual'
          ? 2.2
          : device?.deployment_type === 'physical'
            ? -1.0
            : 0;
      const hostOffset = device?.host_label ? (hash01(`host:${device.host_label}`) - 0.5) * 1.8 : 0;
      const z = deploymentOffset + hostOffset + (hash01(`z:${deviceId}`) - 0.5) * 1.1;
      targetByDeviceId.set(
        deviceId,
        new THREE.Vector3((center - totalWidth / 2) * xSpacing, -depth * ySpacing, z)
      );

      let childLeft = left;
      for (const childId of childrenByDeviceId.get(deviceId) || []) {
        place(childId, childLeft, depth + 1);
        childLeft += subtreeWidth(childId) + branchGap;
      }
    };

    let left = 0;
    for (const rootId of roots) {
      place(rootId, left, 0);
      left += subtreeWidth(rootId) + 1.2;
    }

    return targetByDeviceId;
  }

  computeCentroid(targetByDeviceId) {
    if (!targetByDeviceId.size) {
      return new THREE.Vector3(0, 0, 0);
    }
    const centroid = new THREE.Vector3();
    for (const target of targetByDeviceId.values()) {
      centroid.add(target);
    }
    centroid.divideScalar(targetByDeviceId.size);
    return centroid;
  }

  computeBounds(targetByDeviceId) {
    if (!targetByDeviceId.size) {
      return {
        min: new THREE.Vector3(),
        max: new THREE.Vector3(),
      };
    }

    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const target of targetByDeviceId.values()) {
      min.min(target);
      max.max(target);
    }
    return { min, max };
  }

  createDeviceGroup(device) {
    const group = new THREE.Group();
    const geometry = this.createRoleGeometry(device.device_role);
    const material = new THREE.MeshStandardMaterial({
      color: deploymentColor(device.deployment_type),
      emissive: 0x000000,
      roughness: 0.38,
      metalness: 0.08,
      flatShading: true,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.role = 'device-mesh';
    group.add(mesh);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 18),
      new THREE.LineBasicMaterial({
        color: 0x20324d,
        transparent: true,
        opacity: 0.36,
      })
    );
    group.add(edges);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.5, 0.055, 10, 40),
      new THREE.MeshBasicMaterial({
        color: 0x0f62fe,
        transparent: true,
        opacity: 0.0,
      })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.z = -0.24;
    group.add(ring);

    group.userData = {
      kind: 'device',
      deviceId: device.id,
      device,
      target: new THREE.Vector3(),
      mesh,
      edges,
      ring,
      material,
    };

    return group;
  }

  createRoleGeometry(role) {
    switch (role) {
      case 'router':
        return new THREE.OctahedronGeometry(1.08, 0);
      case 'switch':
        return new THREE.BoxGeometry(1.7, 0.9, 1.1);
      case 'server':
        return new THREE.BoxGeometry(1.02, 1.9, 0.92);
      case 'bridge':
        return new THREE.BoxGeometry(2.0, 0.28, 1.15);
      default:
        return new THREE.IcosahedronGeometry(0.98, 0);
    }
  }

  createLinkGroup(link) {
    const group = new THREE.Group();
    group.userData = {
      kind: 'link',
      linkId: link.id,
      link,
    };

    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const line = new THREE.Line(
      lineGeometry,
      new THREE.LineBasicMaterial({
        color: 0x4b5563,
        transparent: true,
        opacity: 0.76,
      })
    );
    line.userData.role = 'link-line';
    group.add(line);

    const hitMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const hitMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1, 12, 1, true), hitMaterial);
    hitMesh.userData.role = 'link-hit';
    group.add(hitMesh);

    group.userData.line = line;
    group.userData.hitMesh = hitMesh;
    return group;
  }

  updateObjectStyles() {
    const selectedPathDevices = this.pathDeviceIdsForRow(this.selectedRowId);
    const hoveredPathDevices = this.pathDeviceIdsForRow(this.hoveredRowId);
    const selectedPathLinks = this.pathLinkIdsForRow(this.selectedRowId);

    for (const [deviceId, group] of this.deviceGroups.entries()) {
      const isSelected = deviceId === this.selectedDeviceId;
      const isHovered = deviceId === this.hoveredDeviceId;
      const onSelectedPath = selectedPathDevices.has(deviceId) && !isSelected;
      const onHoveredPath = hoveredPathDevices.has(deviceId) && !isSelected && !isHovered;

      const scale = isSelected ? 1.16 : isHovered ? 1.1 : onSelectedPath ? 1.06 : onHoveredPath ? 1.03 : 1;
      group.scale.setScalar(scale);

      const ringOpacity = isSelected ? 0.64 : isHovered ? 0.48 : onSelectedPath ? 0.34 : onHoveredPath ? 0.2 : 0;
      group.userData.ring.material.opacity = ringOpacity;
      group.userData.ring.material.color.setHex(isHovered ? 0xd97706 : 0x0f62fe);

      group.userData.material.emissive.setHex(
        isSelected ? 0x123b88 : isHovered ? 0x7c2d12 : onSelectedPath ? 0x09368f : 0x000000
      );
      group.userData.edges.material.opacity = isSelected || isHovered || onSelectedPath ? 0.62 : 0.36;
      group.userData.edges.material.color.setHex(isHovered ? 0xd97706 : isSelected || onSelectedPath ? 0x0f62fe : 0x20324d);
      group.userData.material.roughness = isSelected || isHovered ? 0.28 : 0.38;
      group.userData.material.color.setHex(deploymentColor(group.userData.device.deployment_type));
    }

    for (const group of this.linkGroups.values()) {
      this.applyLinkStyle(group, selectedPathLinks);
    }
  }

  applyLinkStyle(group, selectedPathLinks) {
    const link = group.userData.link;
    const isHovered = link.id === this.hoveredLinkId;
    const isOnSelectedPath = selectedPathLinks.has(link.id);
    group.userData.line.material.color.setHex(
      isHovered ? 0xd97706 : isOnSelectedPath ? 0x0f62fe : 0x4b5563
    );
    group.userData.line.material.opacity = isHovered ? 1 : isOnSelectedPath ? 0.96 : 0.76;
  }

  handlePointerMove(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.hoverPointer = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };

    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const pickables = [
      ...Array.from(this.linkGroups.values()).flatMap((group) => group.children),
      ...Array.from(this.deviceGroups.values()).flatMap((group) => group.children),
    ];
    const intersects = this.raycaster.intersectObjects(pickables, true);
    const hit = intersects.find((intersection) => {
      const object = intersection.object;
      return (
        object.userData.role === 'link-hit' ||
        object.userData.role === 'device-mesh' ||
        object.parent?.userData.kind === 'device'
      );
    });

    if (!hit) {
      if (this.hoverSource === 'scene') {
        this.clearHover();
      }
      return;
    }

    const object = hit.object.parent?.userData.kind === 'device' ? hit.object.parent : hit.object;
    const deviceGroup = this.findAncestorByKind(object, 'device');
    const linkGroup = this.findAncestorByKind(object, 'link');

    if (linkGroup?.userData?.linkId) {
      this.hoverSource = 'scene';
      this.hoveredLinkId = linkGroup.userData.linkId;
      this.hoveredDeviceId = null;
      this.hoveredEntryId = null;
      this.hoveredRowId = null;
      this.renderHoverCard();
      this.applyTreeHighlights();
      this.updateObjectStyles();
      return;
    }

    if (deviceGroup?.userData?.deviceId) {
      this.setDeviceHover(deviceGroup.userData.deviceId);
    }
  }

  handlePointerLeave() {
    if (this.hoverSource === 'scene') {
      this.clearHover();
    }
  }

  handlePointerClick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const pickables = [
      ...Array.from(this.deviceGroups.values()).flatMap((group) => group.children),
      ...Array.from(this.linkGroups.values()).flatMap((group) => group.children),
    ];
    const intersects = this.raycaster.intersectObjects(pickables, true);
    const hit = intersects.find((intersection) => {
      const object = intersection.object;
      return (
        object.userData.role === 'device-mesh' ||
        object.userData.role === 'link-hit' ||
        object.parent?.userData.kind === 'device'
      );
    });

    if (!hit) {
      return;
    }

    const object = hit.object;
    const deviceGroup = this.findAncestorByKind(object, 'device');
    if (deviceGroup?.userData?.deviceId) {
      const deviceId = deviceGroup.userData.deviceId;
      const entryId =
        this.selectedDeviceId === deviceId && this.selectedEntryId
          ? this.selectedEntryId
          : this.primaryEntryByDevice.get(deviceId) || (this.entryIdsByDeviceId.get(deviceId) || [null])[0];
      if (entryId) {
        this.selectEntry(entryId, { reveal: true, source: 'scene' });
      }
    }
  }

  findAncestorByKind(object, kind) {
    let current = object;
    while (current) {
      if (current.userData?.kind === kind) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  updateViewportState() {
    this.dom.viewport.classList.toggle('is-ready', this.sceneDeviceIds.size > 0);
  }

  animate() {
    const step = () => {
      this.frameRequested = window.requestAnimationFrame(step);

      for (const group of this.deviceGroups.values()) {
        const target = group.userData.target;
        group.position.lerp(target, 0.12);
        if (group.position.distanceTo(target) < 0.01) {
          group.position.copy(target);
        }
      }

      this.updateLinkGeometry();
      this.controls?.update();
      this.renderer.render(this.scene, this.camera);
    };

    if (!this.frameRequested) {
      step();
    }
  }

  updateLinkGeometry() {
    const selectedPathLinks = this.pathLinkIdsForRow(this.selectedRowId);
    for (const group of this.linkGroups.values()) {
      const link = group.userData.link;
      const local = this.deviceGroups.get(link.local_device_id);
      const remote = this.deviceGroups.get(link.remote_device_id);
      if (!local || !remote) {
        continue;
      }

      const start = local.position.clone();
      const end = remote.position.clone();
      const delta = end.clone().sub(start);
      const length = Math.max(delta.length(), 0.001);

      group.userData.line.geometry.setFromPoints([start, end]);
      group.userData.line.geometry.computeBoundingSphere();
      this.applyLinkStyle(group, selectedPathLinks);

      group.userData.hitMesh.position.copy(start.clone().add(end).multiplyScalar(0.5));
      const direction = delta.lengthSq() > 0 ? delta.clone().normalize() : new THREE.Vector3(0, 1, 0);
      group.userData.hitMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      group.userData.hitMesh.scale.set(1, length, 1);
    }
  }
}

const viewer = new TopologyViewer(dom);
window.__latticeViewer = viewer;
viewer.start();
