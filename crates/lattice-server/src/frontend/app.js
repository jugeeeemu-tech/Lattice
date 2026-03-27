import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const STATUS_THEME = {
  loading: { bg: '#e0ecff', fg: '#0f3e98', label: 'loading' },
  discovering: { bg: '#fff1da', fg: '#9a4d00', label: 'discovering' },
  ready: { bg: '#def7ec', fg: '#0f766e', label: 'ready' },
  failed: { bg: '#fee2e2', fg: '#b42318', label: 'failed' },
};

const KIND_LABELS = {
  router: 'Router',
  switch: 'Switch',
  physical_server: 'Physical server',
  bridge: 'Bridge',
  virtual_machine: 'Virtual machine',
  container: 'Container',
  unknown: 'Unknown',
};

const KIND_COLORS = {
  router: 0x2b6cb0,
  switch: 0x2563eb,
  physical_server: 0x0f766e,
  bridge: 0xd97706,
  virtual_machine: 0xea580c,
  container: 0xfb923c,
  unknown: 0x627086,
};

const KIND_SHAPES = {
  router: '八面体',
  switch: '横長直方体',
  physical_server: '縦長直方体',
  bridge: '薄い直方体',
  virtual_machine: '縦長直方体',
  container: '縦長直方体',
  unknown: '二十面体',
};

const LEGEND_ORDER = [
  'router',
  'switch',
  'physical_server',
  'bridge',
  'virtual_machine',
  'container',
  'unknown',
];

const EMPTY_SNAPSHOT = Object.freeze({
  devices: [],
  links: [],
  tree_rows: [],
  tree_edges: [],
  primary_row_by_device: {},
  discovery_status: { kind: 'loading', message: 'initializing' },
});

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
  legendToggle: document.querySelector('[data-action="toggle-legend"]'),
  legendCard: document.querySelector('[data-role="legend-card"]'),
  legendList: document.querySelector('[data-role="legend-list"]'),
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
  return {
    chassis_id: normalizeText(keys.chassis_id, '') || null,
    sys_name: normalizeText(keys.sys_name, '') || null,
    mgmt_ip: normalizeText(keys.mgmt_ip, '') || null,
  };
}

function normalizeDeviceKind(value) {
  const kind = normalizeText(value, 'unknown')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (
    kind === 'router' ||
    kind === 'switch' ||
    kind === 'physical_server' ||
    kind === 'physicalserver' ||
    kind === 'physical' ||
    kind === 'bridge' ||
    kind === 'virtual_machine' ||
    kind === 'virtualmachine' ||
    kind === 'vm' ||
    kind === 'ct' ||
    kind === 'container'
  ) {
    if (kind === 'physicalserver') {
      return 'physical_server';
    }
    if (kind === 'physical') {
      return 'physical_server';
    }
    if (kind === 'virtualmachine') {
      return 'virtual_machine';
    }
    if (kind === 'vm') {
      return 'virtual_machine';
    }
    if (kind === 'ct') {
      return 'container';
    }
    return kind;
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
    device_kind: normalizeDeviceKind(entry.device_kind),
    identity_keys: identityKeys,
    host_label: normalizeText(entry.host_label, '') || null,
    uplink_interface: normalizeText(entry.uplink_interface, '') || null,
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
    speed_bps: entry.speed_bps === null || entry.speed_bps === undefined
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
      Object.entries(asObject(snapshot.primary_row_by_device)).map(([key, value]) => [
        normalizeText(key),
        normalizeText(value),
      ])
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

function formatIdentityValue(value, fallback = 'n/a') {
  return normalizeText(value, fallback);
}

function formatProxmoxNodeLabel(hostLabel) {
  const label = normalizeText(hostLabel, '');
  return label ? `Proxmox node ${label}` : null;
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
    this.visibleRowIds = new Set();
    this.visibleDeviceIds = new Set();
    this.collapsedRowIds = new Set();

    this.deviceGroups = new Map();
    this.linkGroups = new Map();
    this.positionCache = new Map();

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
    this.pointerBindingInstalled = false;
  }

  start() {
    this.installScene();
    this.installDomBindings();
    this.installActionButtons();
    this.renderLegend();
    this.installResizeObserver();
    this.applySnapshot(normalizeSnapshot(EMPTY_SNAPSHOT), { source: 'boot' });
    void this.refreshSnapshot({ quiet: true });
    this.connectWebSocket();
    this.startPolling();
    this.animate();
  }

  installActionButtons() {
    const discoverButton = document.querySelector('[data-action="discover"]');
    const reloadButton = document.querySelector('[data-action="reload"]');

    discoverButton?.addEventListener('click', () => {
      void this.requestDiscovery();
    });

    reloadButton?.addEventListener('click', () => {
      window.location.reload();
    });

    this.dom.legendToggle?.addEventListener('click', () => {
      const shouldOpen = this.dom.legendCard?.hidden !== false;
      this.setLegendOpen(shouldOpen);
    });
  }

  renderLegend() {
    if (!this.dom.legendList) {
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const kind of LEGEND_ORDER) {
      const row = document.createElement('div');
      row.className = 'legend-row';

      const swatch = document.createElement('span');
      swatch.className = 'legend-row__swatch';
      swatch.style.background = `#${KIND_COLORS[kind].toString(16).padStart(6, '0')}`;

      const copy = document.createElement('div');
      copy.className = 'legend-row__copy';

      const title = document.createElement('strong');
      title.textContent = KIND_LABELS[kind];

      const meta = document.createElement('span');
      const family = (
        kind === 'bridge' ||
        kind === 'virtual_machine' ||
        kind === 'container'
      )
        ? '仮想系'
        : kind === 'unknown'
          ? '不明'
          : '物理系';
      meta.textContent = `${KIND_SHAPES[kind]} / ${family}`;

      copy.append(title, meta);
      row.append(swatch, copy);
      fragment.append(row);
    }

    this.dom.legendList.replaceChildren(fragment);
    this.setLegendOpen(false);
  }

  setLegendOpen(open) {
    if (!this.dom.legendCard || !this.dom.legendToggle) {
      return;
    }
    this.dom.legendCard.hidden = !open;
    this.dom.legendToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  installDomBindings() {
    if (this.treeBindingInstalled) {
      return;
    }

    this.treeBindingInstalled = true;

    this.dom.tree.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-role="tree-toggle"]');
      const row = event.target.closest('[data-row-id]');
      if (!row) {
        return;
      }

      const rowId = row.getAttribute('data-row-id');
      if (!rowId) {
        return;
      }

      if (toggle) {
        event.preventDefault();
        event.stopPropagation();
        this.toggleRow(rowId);
        return;
      }

      event.preventDefault();
      this.selectRow(rowId, { reveal: true, source: 'tree' });
    });

    this.dom.tree.addEventListener('pointerover', (event) => {
      const row = event.target.closest('[data-row-id]');
      if (!row) {
        return;
      }
      const rowId = row.getAttribute('data-row-id');
      if (!rowId) {
        return;
      }
      this.setRowHover(rowId);
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
    this.scene.fog = new THREE.Fog(0xf7f9fc, 28, 110);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
    this.camera.position.set(-24, 18, 30);

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
    this.controls.maxDistance = 180;
    this.controls.target.set(0, 0, 0);

    const ambient = new THREE.HemisphereLight(0xffffff, 0xe5ecf6, 2.1);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-20, 24, 16);
    const fill = new THREE.DirectionalLight(0xe5f0ff, 0.75);
    fill.position.set(18, -10, 10);

    this.scene.add(ambient, key, fill);

    const grid = new THREE.GridHelper(120, 48, 0xd8e1eb, 0xe9eef5);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -2;
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    this.scene.add(grid);

    this.deviceRoot = new THREE.Group();
    this.linkRoot = new THREE.Group();
    this.scene.add(this.linkRoot);
    this.scene.add(this.deviceRoot);

    this.pointerBindingInstalled = true;
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
      await fetch('/api/discover', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      await this.refreshSnapshot({ quiet: false });
      this.connectWebSocket();
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
    if (!this.visibleDeviceIds.size && !this.deviceGroups.size) {
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
    const rows = this.snapshot.tree_rows;
    const edges = this.snapshot.tree_edges;

    this.rowById = new Map(rows.map((row) => [row.id, row]));
    this.rowParentById = new Map();
    this.rowChildrenById = new Map(rows.map((row) => [row.id, []]));
    this.rowIdsByDeviceId = new Map();
    this.primaryRowByDevice = new Map(
      Object.entries(this.snapshot.primary_row_by_device).map(([deviceId, rowId]) => [
        deviceId,
        rowId,
      ])
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
        const leftLabel = normalizeText(leftRow?.label, 'Unknown').toLowerCase();
        const rightLabel = normalizeText(rightRow?.label, 'Unknown').toLowerCase();
        if (leftLabel === rightLabel) {
          return left.localeCompare(right);
        }
        return leftLabel.localeCompare(rightLabel);
      });
      this.rowChildrenById.set(rowId, children);
    }

    this.rowDepthById = new Map();
    const roots = rows
      .filter((row) => !this.rowParentById.has(row.id))
      .sort((left, right) => {
        const leftLabel = normalizeText(left.label, 'Unknown').toLowerCase();
        const rightLabel = normalizeText(right.label, 'Unknown').toLowerCase();
        if (leftLabel === rightLabel) {
          return left.id.localeCompare(right.id);
        }
        return leftLabel.localeCompare(rightLabel);
      });

    const visibleRowIds = new Set();
    const visibleDeviceIds = new Set();
    const visited = new Set();

    const walk = (rowId, depth) => {
      if (visited.has(rowId)) {
        return;
      }
      const row = this.rowById.get(rowId);
      if (!row) {
        return;
      }

      visited.add(rowId);
      this.rowDepthById.set(rowId, depth);
      visibleRowIds.add(rowId);
      visibleDeviceIds.add(row.device_id);

      const children = this.rowChildrenById.get(rowId) || [];
      if (this.collapsedRowIds.has(rowId)) {
        return;
      }

      for (const childRowId of children) {
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

    if (!rows.length) {
      for (const device of this.snapshot.devices) {
        visibleDeviceIds.add(device.id);
      }
    } else {
      for (const device of this.snapshot.devices) {
        if (!this.rowIdsByDeviceId.has(device.id)) {
          visibleDeviceIds.add(device.id);
        }
      }
    }

    this.visibleRowIds = visibleRowIds;
    this.visibleDeviceIds = visibleDeviceIds;

    for (const rowId of Array.from(this.collapsedRowIds)) {
      if (!this.rowById.has(rowId)) {
        this.collapsedRowIds.delete(rowId);
      }
    }
    if (this.selectedRowId && !this.rowById.has(this.selectedRowId)) {
      this.selectedRowId = null;
      this.selectedDeviceId = null;
    }
    if (this.hoveredRowId && !this.rowById.has(this.hoveredRowId)) {
      this.hoveredRowId = null;
    }
    if (this.hoveredDeviceId && !this.snapshot.devices.some((device) => device.id === this.hoveredDeviceId)) {
      this.hoveredDeviceId = null;
    }
    if (this.selectedDeviceId && !this.snapshot.devices.some((device) => device.id === this.selectedDeviceId)) {
      this.selectedDeviceId = null;
    }
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
        discovering: '探索を実行中',
        ready: '最新の構成を表示中',
        failed: '前回の構成を維持しています',
      }[status.kind] || '状態を取得中');
    this.dom.statusMessage.textContent = message;
    this.dom.summary.textContent = `${this.snapshot.devices.length} devices / ${this.snapshot.links.length} links`;
  }

  renderTree() {
    const fragment = document.createDocumentFragment();
    const visited = new Set();
    const roots = this.snapshot.tree_rows
      .filter((row) => !this.rowParentById.has(row.id))
      .sort((left, right) => {
        const leftLabel = normalizeText(left.label, 'Unknown').toLowerCase();
        const rightLabel = normalizeText(right.label, 'Unknown').toLowerCase();
        if (leftLabel === rightLabel) {
          return left.id.localeCompare(right.id);
        }
        return leftLabel.localeCompare(rightLabel);
      });

    const addRow = (rowId, depth) => {
      if (visited.has(rowId)) {
        return;
      }
      const row = this.rowById.get(rowId);
      if (!row || !this.visibleRowIds.has(rowId)) {
        return;
      }

      visited.add(rowId);
      const rowEl = document.createElement('div');
      rowEl.className = 'tree-row';
      rowEl.dataset.rowId = row.id;
      rowEl.dataset.deviceId = row.device_id;
      rowEl.setAttribute('role', 'treeitem');
      rowEl.setAttribute('aria-level', String(depth + 1));
      rowEl.style.paddingInlineStart = `${0.5 + depth * 1.05}rem`;

      const hasChildren = (this.rowChildrenById.get(row.id) || []).length > 0;
      const expanded = !this.collapsedRowIds.has(row.id);
      if (hasChildren) {
        rowEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      }
      if (hasChildren && expanded) {
        rowEl.classList.add('is-open');
      }

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'tree-row__toggle';
      toggle.dataset.role = 'tree-toggle';
      toggle.setAttribute('aria-label', hasChildren ? (expanded ? '折りたたむ' : '展開する') : 'leaf');
      if (!hasChildren) {
        toggle.classList.add('tree-row__toggle--leaf');
      }

      const labelButton = document.createElement('button');
      labelButton.type = 'button';
      labelButton.className = 'tree-row__label';
      labelButton.dataset.role = 'tree-label';

      const name = document.createElement('span');
      name.className = 'tree-row__name';
      name.textContent = row.label || 'Unknown';

      const meta = document.createElement('span');
      meta.className = 'tree-row__meta';
      const device = this.snapshot.devices.find((candidate) => candidate.id === row.device_id);
      meta.textContent = [
        KIND_LABELS[device?.device_kind || 'unknown'],
        formatProxmoxNodeLabel(device?.host_label),
        `depth ${this.rowDepthById.get(row.id) ?? depth}`,
      ]
        .filter(Boolean)
        .join(' · ');

      labelButton.append(name, meta);
      rowEl.append(toggle, labelButton);
      fragment.append(rowEl);

      const children = this.rowChildrenById.get(row.id) || [];
      if (!this.collapsedRowIds.has(row.id)) {
        for (const childRowId of children) {
          addRow(childRowId, depth + 1);
        }
      }
    };

    if (roots.length) {
      for (const root of roots) {
        addRow(root.id, this.rowDepthById.get(root.id) || 0);
      }
    } else {
      for (const row of this.snapshot.tree_rows) {
        addRow(row.id, this.rowDepthById.get(row.id) || 0);
      }
    }

    this.dom.tree.replaceChildren(fragment);

    if (!this.dom.tree.children.length) {
      const empty = document.createElement('div');
      empty.className = 'tree__empty';
      empty.textContent = 'ツリーのデータを待っています。';
      this.dom.tree.replaceChildren(empty);
    }

    this.applyTreeHighlights();
  }

  syncScene() {
    const visibleDevices = this.snapshot.devices.filter((device) => this.visibleDeviceIds.has(device.id));
    const targetByDeviceId = this.computeTargets(visibleDevices);
    const visibleDeviceSet = new Set(visibleDevices.map((device) => device.id));

    if (!this.framedScene && visibleDevices.length) {
      const centroid = this.computeCentroid(targetByDeviceId);
      this.controls.target.copy(centroid);
      this.camera.position.set(centroid.x - 22, centroid.y + 18, centroid.z + 28);
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
    const countsByDepth = new Map();
    let deepest = 0;

    for (const device of devices) {
      const depth = Math.max(0, Math.floor(device.depth || 0));
      deepest = Math.max(deepest, depth);
      countsByDepth.set(depth, (countsByDepth.get(depth) || 0) + 1);
    }

    const targetByDeviceId = new Map();
    const depthSpacing = 4.4;

    for (const device of devices) {
      const depth = Math.max(0, Math.floor(device.depth || 0));
      const count = countsByDepth.get(depth) || 1;
      const baseRadius = 5.4 + depth * 2.6 + Math.max(0, count - 1) * 0.2;
      const angle = hash01(`${device.id}:${depth}`) * Math.PI * 2;
      const radialScale = 0.88 + hash01(`radius:${device.id}`) * 0.3;
      const x = Math.cos(angle) * baseRadius * radialScale;
      const y = Math.sin(angle) * baseRadius * radialScale;
      const z = (depth - deepest / 2) * depthSpacing;
      targetByDeviceId.set(device.id, new THREE.Vector3(x, y, z));
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

  createDeviceGroup(device) {
    const group = new THREE.Group();
    const color = KIND_COLORS[device.device_kind] || KIND_COLORS.unknown;
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: 0x000000,
      roughness: 0.38,
      metalness: 0.08,
      flatShading: true,
    });

    let geometry;
    switch (device.device_kind) {
      case 'router':
        geometry = new THREE.OctahedronGeometry(1.06, 0);
        break;
      case 'switch':
        geometry = new THREE.BoxGeometry(1.6, 0.95, 1.1);
        break;
      case 'physical_server':
      case 'virtual_machine':
      case 'container':
        geometry = new THREE.BoxGeometry(1.05, 1.9, 0.92);
        break;
      case 'bridge':
        geometry = new THREE.BoxGeometry(1.9, 0.28, 1.15);
        break;
      default:
        geometry = new THREE.IcosahedronGeometry(0.98, 0);
        break;
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.role = 'device-mesh';
    group.add(mesh);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 18),
      new THREE.LineBasicMaterial({
        color: 0x20324d,
        transparent: true,
        opacity: 0.35,
      })
    );
    group.add(edges);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.45, 0.055, 10, 40),
      new THREE.MeshBasicMaterial({
        color: 0x0f62fe,
        transparent: true,
        opacity: 0.0,
      })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.z = -0.2;
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
      baseScale: 1,
    };

    return group;
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
        color: 0x374151,
        transparent: true,
        opacity: 0.75,
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
    group.userData.baseOpacity = 0.75;
    return group;
  }

  updateObjectStyles() {
    for (const [deviceId, group] of this.deviceGroups.entries()) {
      const isSelected = deviceId === this.selectedDeviceId;
      const isHovered = deviceId === this.hoveredDeviceId;
      const isAncestor =
        this.selectedRowId && this.rowIdsByDeviceId.get(deviceId)?.includes(this.selectedRowId);
      const isActive = isSelected || isHovered || isAncestor;
      const scale = isSelected ? 1.16 : isHovered ? 1.1 : isAncestor ? 1.05 : 1;
      group.scale.setScalar(scale);
      group.userData.ring.material.opacity = isActive ? 0.58 : 0.0;
      group.userData.ring.material.color.setHex(isSelected ? 0x0f62fe : isHovered ? 0xd97706 : 0x0f62fe);
      group.userData.material.emissive.setHex(isSelected ? 0x123b88 : isHovered ? 0x7c2d12 : 0x000000);
      group.userData.edges.material.opacity = isActive ? 0.58 : 0.35;
      group.userData.edges.material.color.setHex(isActive ? 0x0f62fe : 0x20324d);
      group.userData.material.roughness = isActive ? 0.28 : 0.38;
    }

    for (const [linkId, group] of this.linkGroups.entries()) {
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
      group.userData.line.material.color.setHex(link.id === this.hoveredLinkId ? 0xd97706 : 0x374151);
      group.userData.line.material.opacity = link.id === this.hoveredLinkId ? 0.95 : 0.75;

      const mid = start.clone().add(end).multiplyScalar(0.5);
      group.userData.hitMesh.position.copy(mid);
      const direction = delta.lengthSq() > 0 ? delta.clone().normalize() : new THREE.Vector3(0, 1, 0);
      group.userData.hitMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      group.userData.hitMesh.scale.set(1, length, 1);
      group.userData.hitMesh.material.opacity = 0.0;
      group.userData.hitMesh.userData.linkId = linkId;
      group.userData.hitMesh.userData.link = link;
      group.userData.hitMesh.renderOrder = 0;
    }
  }

  applyTreeHighlights() {
    const hoveredRows = this.getHoveredRows();
    const selectedPath = this.selectedRowId ? new Set(findRowPath(this.selectedRowId, this.rowParentById)) : new Set();
    const hoveredPath = new Set();
    for (const rowId of hoveredRows) {
      for (const ancestor of findRowPath(rowId, this.rowParentById)) {
        hoveredPath.add(ancestor);
      }
    }

    for (const rowEl of this.dom.tree.querySelectorAll('[data-row-id]')) {
      const rowId = rowEl.getAttribute('data-row-id');
      const row = this.rowById.get(rowId);
      const isSelected = rowId === this.selectedRowId;
      const isHovered = hoveredPath.has(rowId);
      const isAncestor = selectedPath.has(rowId) && !isSelected;
      rowEl.classList.toggle('is-selected', isSelected);
      rowEl.classList.toggle('is-hovered', isHovered);
      rowEl.classList.toggle('is-ancestor', isAncestor);
      if (row) {
        const expanded = !this.collapsedRowIds.has(rowId);
        const hasChildren = (this.rowChildrenById.get(rowId) || []).length > 0;
        if (hasChildren) {
          rowEl.classList.toggle('is-open', expanded);
          rowEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        }
      }
    }
  }

  getHoveredRows() {
    if (this.hoverSource === 'tree' && this.hoveredRowId) {
      return [this.hoveredRowId];
    }
    if (this.hoverSource === 'scene') {
      if (this.hoveredDeviceId) {
        return this.rowIdsByDeviceId.get(this.hoveredDeviceId) || [];
      }
      if (this.hoveredRowId) {
        return [this.hoveredRowId];
      }
    }
    return [];
  }

  syncSelectionAfterSnapshot() {
    if (this.selectedRowId && !this.rowById.has(this.selectedRowId)) {
      this.selectedRowId = null;
    }
    if (this.selectedDeviceId && !this.snapshot.devices.some((device) => device.id === this.selectedDeviceId)) {
      this.selectedDeviceId = null;
    } else if (!this.selectedRowId && this.selectedDeviceId) {
      this.selectedRowId = this.primaryRowByDevice.get(this.selectedDeviceId) || null;
    }
    if (this.hoveredRowId && !this.rowById.has(this.hoveredRowId)) {
      this.hoveredRowId = null;
    }
    if (this.hoveredDeviceId && !this.snapshot.devices.some((device) => device.id === this.hoveredDeviceId)) {
      this.hoveredDeviceId = null;
    } else if (!this.hoveredRowId && this.hoveredDeviceId && this.hoverSource === 'tree') {
      this.hoveredRowId = this.primaryRowByDevice.get(this.hoveredDeviceId) || null;
    }

    this.applyTreeHighlights();
    this.renderHoverCard();
  }

  toggleRow(rowId) {
    if (this.collapsedRowIds.has(rowId)) {
      this.collapsedRowIds.delete(rowId);
    } else {
      this.collapsedRowIds.add(rowId);
    }
    this.refreshSnapshotModel();
    this.renderTree();
    this.syncScene();
  }

  selectRow(rowId, { reveal = false, source = 'tree' } = {}) {
    const row = this.rowById.get(rowId);
    if (!row) {
      return;
    }

    this.selectedRowId = rowId;
    this.selectedDeviceId = row.device_id;
    this.hoverSource = source;
    this.hoveredRowId = rowId;
    this.hoveredDeviceId = row.device_id;
    this.hoveredLinkId = null;

    if (reveal) {
      this.revealRow(rowId);
    }

    this.applyTreeHighlights();
    this.updateObjectStyles();
    this.renderHoverCard();
    this.scrollRowIntoView(rowId);
  }

  revealRow(rowId) {
    for (const ancestor of findRowPath(rowId, this.rowParentById)) {
      this.collapsedRowIds.delete(ancestor);
    }
    this.refreshSnapshotModel();
    this.renderTree();
    this.syncScene();
  }

  setRowHover(rowId) {
    const row = this.rowById.get(rowId);
    if (!row) {
      return;
    }
    this.hoverSource = 'tree';
    this.hoveredRowId = rowId;
    this.hoveredDeviceId = row.device_id;
    this.hoveredLinkId = null;
    this.renderHoverCardForRow(rowId, row.device_id);
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
    this.hoveredRowId = null;
    this.renderHoverCard();
    this.applyTreeHighlights();
    this.updateObjectStyles();
  }

  clearHover() {
    this.hoverSource = null;
    this.hoveredRowId = null;
    this.hoveredDeviceId = null;
    this.hoveredLinkId = null;
    this.renderHoverCard();
    this.applyTreeHighlights();
    this.updateObjectStyles();
  }

  scrollRowIntoView(rowId) {
    const rowElement = this.dom.tree.querySelector(`[data-row-id="${CSS.escape(rowId)}"]`);
    if (rowElement) {
      rowElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  updateEmptyState() {
    const hasRenderableTopology = this.visibleDeviceIds.size > 0;
    this.dom.viewport.classList.toggle('is-ready', hasRenderableTopology);

    if (hasRenderableTopology) {
      this.dom.emptyState.innerHTML = '';
      return;
    }

    const status = this.snapshot.discovery_status || { kind: 'loading', message: '' };
    const titleByStatus = {
      loading: 'Topology is warming up',
      discovering: 'Discovery is running',
      failed: 'Discovery failed',
      ready: 'No devices to render',
    };

    const bodyByStatus = {
      loading: '初回探索が完了すると、3D ビューと案内ツリーが表示されます。',
      discovering: '最新の構成を組み立てています。完了後に自動で切り替わります。',
      failed: status.message || '探索に失敗しました。旧構成があればそのまま保持しています。',
      ready: '可視化できる機器がありません。',
    };

    this.dom.emptyState.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'empty-card';
    const title = document.createElement('p');
    title.className = 'empty-card__title';
    title.textContent = titleByStatus[status.kind] || titleByStatus.loading;
    const body = document.createElement('p');
    body.className = 'empty-card__body';
    body.textContent = bodyByStatus[status.kind] || bodyByStatus.loading;
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

  linksForDevice(deviceId, protocol = null) {
    return this.snapshot.links.filter((link) => {
      if (protocol && link.protocol !== protocol) {
        return false;
      }
      return link.local_device_id === deviceId || link.remote_device_id === deviceId;
    });
  }

  bridgeUplinkText(device) {
    const uplinkLink = this.linksForDevice(device.id, 'proxmox_uplink')[0];
    if (uplinkLink) {
      const isLocal = uplinkLink.local_device_id === device.id;
      const bridgeInterface = isLocal ? uplinkLink.local_interface : uplinkLink.remote_interface;
      const remoteDevice = this.findDevice(isLocal ? uplinkLink.remote_device_id : uplinkLink.local_device_id);
      const remoteInterface = isLocal ? uplinkLink.remote_interface : uplinkLink.local_interface;
      return `${bridgeInterface} -> ${remoteDevice?.label || 'physical'}:${remoteInterface}`;
    }
    if (device.uplink_interface) {
      return `${device.uplink_interface} (未接続)`;
    }
    return '未接続';
  }

  guestBridgeText(device) {
    const bridgeLabels = this.linksForDevice(device.id, 'proxmox_guest_link')
      .map((link) => {
        const bridgeId = link.local_device_id === device.id ? link.remote_device_id : link.local_device_id;
        return this.findDevice(bridgeId)?.label || null;
      })
      .filter(Boolean);
    return bridgeLabels.length ? bridgeLabels.join(', ') : '未接続';
  }

  deviceHoverDetails(device) {
    const details = [KIND_LABELS[device.device_kind] || KIND_LABELS.unknown];
    const proxmoxNodeLabel = formatProxmoxNodeLabel(device.host_label);
    if (proxmoxNodeLabel) {
      details.push(proxmoxNodeLabel);
    }
    if (device.identity_keys.mgmt_ip) {
      details.push(`Mgmt ${device.identity_keys.mgmt_ip}`);
    }

    if (device.device_kind === 'bridge') {
      details.push(`Uplink ${this.bridgeUplinkText(device)}`);
    } else if (device.device_kind === 'virtual_machine' || device.device_kind === 'container') {
      details.push(`Bridge ${this.guestBridgeText(device)}`);
    } else if (device.identity_keys.sys_name) {
      details.push(`Host ${device.identity_keys.sys_name}`);
    }

    return details;
  }

  renderHoverCard() {
    if (this.hoverSource === 'tree' && this.hoveredRowId) {
      const row = this.rowById.get(this.hoveredRowId);
      if (row) {
        this.renderHoverCardForRow(row.id, row.device_id);
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
      const device = this.snapshot.devices.find((candidate) => candidate.id === this.hoveredDeviceId);
      if (device) {
        this.renderHoverCardForDevice(device);
        return;
      }
    }

    this.dom.hoverCard.hidden = true;
  }

  renderHoverCardForRow(rowId, deviceId) {
    const row = this.rowById.get(rowId);
    const device = this.snapshot.devices.find((candidate) => candidate.id === deviceId);
    if (!row || !device) {
      this.dom.hoverCard.hidden = true;
      return;
    }
    this.dom.hoverCard.hidden = false;
    this.dom.hoverTitle.textContent = row.label || device.label || 'Unknown';
    const details = [...this.deviceHoverDetails(device), `Depth ${device.depth}`];
    this.dom.hoverBody.textContent = details.join(' · ');
    this.positionHoverCard(this.dom.hoverCard, 20, 20);
  }

  renderHoverCardForDevice(device) {
    this.dom.hoverCard.hidden = false;
    this.dom.hoverTitle.textContent = device.label || device.identity_keys.sys_name || 'Unknown';
    const details = this.deviceHoverDetails(device);
    this.dom.hoverBody.textContent = details.join(' · ');
    this.positionHoverCard(this.dom.hoverCard, this.hoverPointer.x + 18, this.hoverPointer.y + 18);
  }

  renderHoverCardForLink(link) {
    this.dom.hoverCard.hidden = false;
    const local = this.snapshot.devices.find((candidate) => candidate.id === link.local_device_id);
    const remote = this.snapshot.devices.find((candidate) => candidate.id === link.remote_device_id);
    this.dom.hoverTitle.textContent = `${local?.label || link.local_interface} ↔ ${remote?.label || link.remote_interface}`;
    const details = [
      `Local ${link.local_interface}${link.local_ip ? ` · ${link.local_ip}` : ''}`,
      `Remote ${link.remote_interface}${link.remote_ip ? ` · ${link.remote_ip}` : ''}`,
      formatSpeed(link.speed_bps),
      link.protocol,
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
      this.hoveredRowId = null;
      this.renderHoverCard();
      this.applyTreeHighlights();
      this.updateObjectStyles();
      return;
    }

    if (deviceGroup?.userData?.deviceId) {
      const deviceId = deviceGroup.userData.deviceId;
      this.setDeviceHover(deviceId);
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
      const rowId = this.primaryRowByDevice.get(deviceId) || (this.rowIdsByDeviceId.get(deviceId) || [null])[0];
      if (rowId) {
        this.selectRow(rowId, { reveal: true, source: 'scene' });
      } else {
        this.selectedDeviceId = deviceId;
        this.updateObjectStyles();
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
    this.dom.viewport.classList.toggle('is-ready', this.visibleDeviceIds.size > 0);
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
      group.userData.line.material.color.setHex(
        link.id === this.hoveredLinkId ? 0xd97706 : 0x374151
      );
      group.userData.line.material.opacity = link.id === this.hoveredLinkId ? 1 : 0.78;

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
