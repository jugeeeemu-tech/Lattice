const suiteOrder = ['push', 'nightly'];

function link(a, b) {
  return { a, b };
}

function sortedPair(a, b) {
  return [a, b].sort((left, right) => left.localeCompare(right)).join('::');
}

function inferDeviceRole(label) {
  const lowered = label.toLowerCase();
  if (lowered.includes('router') || lowered.includes('vyos')) {
    return 'router';
  }
  if (lowered.includes('switch')) {
    return 'switch';
  }
  if (lowered.includes('server') || lowered.includes('linux') || lowered.includes('proxmox')) {
    return 'server';
  }
  return 'unknown';
}

function scenario({
  name,
  suite,
  root,
  links,
  focusLabels,
  disabledLinks = [],
  disabledSnmp = [],
}) {
  const nodes = Array.from(new Set([root, ...links.flatMap(({ a, b }) => [a, b])])).sort((left, right) =>
    left.localeCompare(right)
  );

  return {
    name,
    suite,
    root,
    nodes,
    links,
    focusLabels,
    disabledLinks,
    disabledSnmp,
  };
}

function linearScenario() {
  return scenario({
    name: 'linear-3',
    suite: 'push',
    root: 'edge-router-1',
    links: [link('edge-router-1', 'aggregation-switch-1'), link('aggregation-switch-1', 'app-server-1')],
  });
}

function starScenario() {
  return scenario({
    name: 'star-5',
    suite: 'push',
    root: 'hub-switch-1',
    links: [
      link('hub-switch-1', 'app-server-1'),
      link('hub-switch-1', 'app-server-2'),
      link('hub-switch-1', 'branch-router-1'),
      link('hub-switch-1', 'branch-router-2'),
    ],
  });
}

function ringScenario() {
  return scenario({
    name: 'ring-4',
    suite: 'push',
    root: 'ring-router-1',
    links: [
      link('ring-router-1', 'ring-router-2'),
      link('ring-router-2', 'ring-router-3'),
      link('ring-router-3', 'ring-router-4'),
      link('ring-router-4', 'ring-router-1'),
    ],
  });
}

function campusScenario() {
  return scenario({
    name: 'campus-12',
    suite: 'push',
    root: 'core-router-1',
    links: [
      link('core-router-1', 'dist-switch-a'),
      link('core-router-1', 'dist-switch-b'),
      link('core-router-1', 'dist-switch-c'),
      link('dist-switch-a', 'access-switch-a1'),
      link('dist-switch-a', 'access-switch-a2'),
      link('dist-switch-b', 'access-switch-b1'),
      link('dist-switch-b', 'access-switch-b2'),
      link('dist-switch-c', 'access-switch-c1'),
      link('dist-switch-c', 'access-switch-c2'),
      link('access-switch-a1', 'app-server-a'),
      link('access-switch-b1', 'app-server-b'),
    ],
  });
}

function branchHubScenario() {
  const links = [];
  for (let index = 1; index <= 5; index += 1) {
    const branch = `branch-router-${index}`;
    links.push(link('hub-router-1', branch));
    links.push(link(branch, `branch-switch-${index}a`));
    links.push(link(branch, `branch-switch-${index}b`));
  }

  return scenario({
    name: 'branch-hub-16',
    suite: 'push',
    root: 'hub-router-1',
    links,
  });
}

function redundantUplinkScenario() {
  const links = [
    link('core-router-1', 'dist-switch-a'),
    link('core-router-2', 'dist-switch-a'),
    link('core-router-1', 'dist-switch-b'),
    link('core-router-2', 'dist-switch-b'),
    link('core-router-1', 'dist-switch-c'),
    link('core-router-2', 'dist-switch-c'),
    link('core-router-1', 'dist-switch-d'),
    link('core-router-2', 'dist-switch-d'),
    link('dist-switch-a', 'access-switch-a1'),
    link('dist-switch-a', 'access-switch-a2'),
    link('dist-switch-b', 'access-switch-b1'),
    link('dist-switch-b', 'access-switch-b2'),
    link('dist-switch-c', 'access-switch-c1'),
    link('dist-switch-c', 'access-switch-c2'),
    link('dist-switch-d', 'access-switch-d1'),
    link('dist-switch-d', 'access-switch-d2'),
    link('access-switch-a1', 'app-server-a1'),
    link('access-switch-b1', 'app-server-b1'),
    link('access-switch-c1', 'app-server-c1'),
    link('access-switch-d1', 'app-server-d1'),
  ];

  return scenario({
    name: 'redundant-uplink-18',
    suite: 'push',
    root: 'core-router-1',
    links,
  });
}

function enterpriseCampusScenario() {
  const links = [];
  const distLabels = ['a', 'b', 'c', 'd', 'e', 'f'];
  let serverIndex = 0;

  for (const label of distLabels) {
    const dist = `dist-switch-${label}`;
    links.push(link('core-router-1', dist));
    links.push(link('core-router-2', dist));

    for (let accessIndex = 1; accessIndex <= 3; accessIndex += 1) {
      const access = `access-switch-${label}${accessIndex}`;
      links.push(link(dist, access));

      if (serverIndex < 10 && accessIndex !== 3) {
        serverIndex += 1;
        links.push(link(access, `app-server-${serverIndex.toString().padStart(2, '0')}`));
      }
    }
  }

  return scenario({
    name: 'enterprise-campus-36',
    suite: 'nightly',
    root: 'core-router-1',
    links,
    focusLabels: [
      'core-router-1',
      'core-router-2',
      'dist-switch-a',
      'dist-switch-f',
      'access-switch-a1',
      'access-switch-f3',
      'app-server-01',
      'app-server-10',
    ],
  });
}

function multiBranchScenario() {
  const links = [link('hub-router-1', 'hub-router-2')];
  let serverNumber = 0;

  for (let branchIndex = 1; branchIndex <= 10; branchIndex += 1) {
    const branch = `branch-router-${branchIndex.toString().padStart(2, '0')}`;
    links.push(link(branchIndex <= 5 ? 'hub-router-1' : 'hub-router-2', branch));
    links.push(link(branch, `branch-switch-${branchIndex.toString().padStart(2, '0')}a`));
    links.push(link(branch, `branch-switch-${branchIndex.toString().padStart(2, '0')}b`));

    if (branchIndex <= 8) {
      serverNumber += 1;
      links.push(
        link(
          `branch-switch-${branchIndex.toString().padStart(2, '0')}a`,
          `app-server-${serverNumber.toString().padStart(2, '0')}`
        )
      );
      serverNumber += 1;
      links.push(
        link(
          `branch-switch-${branchIndex.toString().padStart(2, '0')}b`,
          `app-server-${serverNumber.toString().padStart(2, '0')}`
        )
      );
    }
  }

  return scenario({
    name: 'multi-branch-48',
    suite: 'nightly',
    root: 'hub-router-1',
    links,
    focusLabels: [
      'hub-router-1',
      'hub-router-2',
      'branch-router-01',
      'branch-router-10',
      'branch-switch-01a',
      'branch-switch-10b',
      'app-server-01',
      'app-server-16',
    ],
  });
}

function mixedHierarchyScenario() {
  const links = [
    link('core-router-1', 'core-router-2'),
    link('core-router-2', 'core-router-3'),
    link('core-router-3', 'core-router-4'),
    link('core-router-4', 'core-router-1'),
  ];
  const distToCores = [
    ['dist-switch-a', 'core-router-1', 'core-router-2'],
    ['dist-switch-b', 'core-router-1', 'core-router-2'],
    ['dist-switch-c', 'core-router-2', 'core-router-3'],
    ['dist-switch-d', 'core-router-2', 'core-router-3'],
    ['dist-switch-e', 'core-router-3', 'core-router-4'],
    ['dist-switch-f', 'core-router-4', 'core-router-1'],
  ];
  let serverNumber = 0;

  for (const [dist, leftCore, rightCore] of distToCores) {
    links.push(link(leftCore, dist));
    links.push(link(rightCore, dist));

    for (let accessIndex = 1; accessIndex <= 3; accessIndex += 1) {
      const access = `${dist.replace('dist', 'access')}${accessIndex}`;
      links.push(link(dist, access));
      if (accessIndex <= 2) {
        serverNumber += 1;
        links.push(link(access, `app-server-${serverNumber.toString().padStart(2, '0')}`));
      }
    }
  }

  links.push(link('access-switch-a1', 'access-switch-b1'));
  links.push(link('access-switch-c2', 'access-switch-d2'));

  return scenario({
    name: 'mixed-hierarchy-42',
    suite: 'nightly',
    root: 'core-router-1',
    links,
    focusLabels: [
      'core-router-1',
      'core-router-3',
      'dist-switch-a',
      'dist-switch-f',
      'access-switch-a1',
      'access-switch-f3',
      'app-server-01',
      'app-server-12',
    ],
  });
}

function campusLinkDownScenario() {
  const base = enterpriseCampusScenario();
  return scenario({
    ...base,
    name: 'campus-link-down',
    disabledLinks: [link('dist-switch-c', 'access-switch-c2')],
  });
}

function branchSnmpMissingScenario() {
  const base = multiBranchScenario();
  return scenario({
    ...base,
    name: 'branch-snmp-missing',
    disabledSnmp: ['branch-router-07'],
  });
}

const baseScenarios = [
  linearScenario(),
  starScenario(),
  ringScenario(),
  campusScenario(),
  branchHubScenario(),
  redundantUplinkScenario(),
  enterpriseCampusScenario(),
  multiBranchScenario(),
  mixedHierarchyScenario(),
  campusLinkDownScenario(),
  branchSnmpMissingScenario(),
];

export const scenarios = baseScenarios.map((entry, index) => ({
  ...entry,
  scenarioIndex: index + 10,
}));

export function listSuites() {
  return suiteOrder.slice();
}

export function listScenarioNames(suite) {
  return scenarios
    .filter((scenarioEntry) => scenarioEntry.suite === suite)
    .map((scenarioEntry) => scenarioEntry.name);
}

export function getScenario(name) {
  const scenarioEntry = scenarios.find((candidate) => candidate.name === name);
  if (!scenarioEntry) {
    throw new Error(`Unknown topology reflection scenario: ${name}`);
  }

  return structuredClone(scenarioEntry);
}

function subnetForIndex(scenarioIndex, linkIndex) {
  const secondOctet = 16 + (scenarioIndex % 16);
  const thirdOctet = Math.floor(linkIndex / 64);
  const fourthOctet = (linkIndex % 64) * 4;
  return {
    left: `10.${secondOctet}.${thirdOctet}.${fourthOctet + 1}/30`,
    right: `10.${secondOctet}.${thirdOctet}.${fourthOctet + 2}/30`,
  };
}

function mgmtAddressForNode(scenarioIndex, nodeIndex) {
  const thirdOctet = scenarioIndex;
  const fourthOctet = 10 + nodeIndex;
  return `172.31.${thirdOctet}.${fourthOctet}`;
}

function buildTopologyShape(scenarioEntry) {
  const interfaceStateByNode = new Map(
    scenarioEntry.nodes.map((nodeLabel, nodeIndex) => [
      nodeLabel,
      {
        index: nodeIndex,
        mgmtIp: mgmtAddressForNode(scenarioEntry.scenarioIndex, nodeIndex),
        interfaces: [],
      },
    ])
  );
  const disabledLinkKeys = new Set(
    scenarioEntry.disabledLinks.map(({ a, b }) => sortedPair(a, b))
  );
  const links = scenarioEntry.links.map((edge, linkIndex) => {
    const leftState = interfaceStateByNode.get(edge.a);
    const rightState = interfaceStateByNode.get(edge.b);
    if (!leftState || !rightState) {
      throw new Error(`Link references an unknown node: ${edge.a} <-> ${edge.b}`);
    }

    const leftInterface = `eth${leftState.interfaces.length + 1}`;
    const rightInterface = `eth${rightState.interfaces.length + 1}`;
    const subnet = subnetForIndex(scenarioEntry.scenarioIndex, linkIndex);
    const linkKey = sortedPair(edge.a, edge.b);
    const disabled = disabledLinkKeys.has(linkKey);

    leftState.interfaces.push({
      cidr: subnet.left,
      name: leftInterface,
      peer: edge.b,
      peerInterface: rightInterface,
      disabled,
    });
    rightState.interfaces.push({
      cidr: subnet.right,
      name: rightInterface,
      peer: edge.a,
      peerInterface: leftInterface,
      disabled,
    });

    return {
      a: edge.a,
      aInterface: leftInterface,
      aIp: subnet.left,
      b: edge.b,
      bInterface: rightInterface,
      bIp: subnet.right,
      disabled,
    };
  });

  return {
    interfaceStateByNode,
    links,
  };
}

function adjacencyForScenario(derivedScenario, { includeDisabledSnmp = false } = {}) {
  const disabledSnmp = includeDisabledSnmp ? new Set() : new Set(derivedScenario.disabledSnmp);
  const adjacency = new Map(
    derivedScenario.nodes.map((label) => [
      label,
      {
        disabledSnmp: disabledSnmp.has(label),
        edges: [],
      },
    ])
  );

  for (const edge of derivedScenario.derivedLinks) {
    if (edge.disabled) {
      continue;
    }
    adjacency.get(edge.a).edges.push({
      interface: edge.aInterface,
      peer: edge.b,
      peerInterface: edge.bInterface,
    });
    adjacency.get(edge.b).edges.push({
      interface: edge.bInterface,
      peer: edge.a,
      peerInterface: edge.aInterface,
    });
  }

  for (const value of adjacency.values()) {
    value.edges.sort((left, right) => left.interface.localeCompare(right.interface));
  }

  return adjacency;
}

function buildExpectedTree(derivedScenario) {
  const adjacency = adjacencyForScenario(derivedScenario);
  const root = derivedScenario.root;
  const queue = [root];
  const discovered = new Set();
  const parentByLabel = new Map();
  const depthByLabel = new Map();
  const rowIdByLabel = new Map();

  if (adjacency.get(root)?.disabledSnmp) {
    return {
      depthByLabel,
      discoveredLabels: [],
      parentByLabel,
      rowIdByLabel,
    };
  }

  discovered.add(root);
  depthByLabel.set(root, 0);
  rowIdByLabel.set(root, `seed/${root}`);

  while (queue.length > 0) {
    const current = queue.shift();
    const currentRowId = rowIdByLabel.get(current);
    const currentDepth = depthByLabel.get(current) ?? 0;

    for (const edge of adjacency.get(current)?.edges ?? []) {
      if (adjacency.get(edge.peer)?.disabledSnmp) {
        continue;
      }
      if (discovered.has(edge.peer)) {
        continue;
      }
      discovered.add(edge.peer);
      parentByLabel.set(edge.peer, current);
      depthByLabel.set(edge.peer, currentDepth + 1);
      rowIdByLabel.set(edge.peer, `${currentRowId}/${edge.peer}`);
      queue.push(edge.peer);
    }
  }

  return {
    depthByLabel,
    discoveredLabels: Array.from(discovered).sort((left, right) => left.localeCompare(right)),
    parentByLabel,
    rowIdByLabel,
  };
}

function normalizeLink(leftLabel, leftInterface, rightLabel, rightInterface) {
  const leftKey = `${leftLabel}::${leftInterface}`;
  const rightKey = `${rightLabel}::${rightInterface}`;
  if (leftKey <= rightKey) {
    return {
      local_interface: leftInterface,
      local_label: leftLabel,
      protocol: 'lldp',
      remote_interface: rightInterface,
      remote_label: rightLabel,
    };
  }

  return {
    local_interface: rightInterface,
    local_label: rightLabel,
    protocol: 'lldp',
    remote_interface: leftInterface,
    remote_label: leftLabel,
  };
}

function buildExpectedSnapshot(derivedScenario) {
  const tree = buildExpectedTree(derivedScenario);
  const discoveredSet = new Set(tree.discoveredLabels);
  const devices = tree.discoveredLabels
    .map((label) => ({
      depth: tree.depthByLabel.get(label) ?? 0,
      deployment_type: 'unknown',
      device_role: inferDeviceRole(label),
      label,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  const links = derivedScenario.derivedLinks
    .filter((edge) => !edge.disabled)
    .filter((edge) => discoveredSet.has(edge.a) && discoveredSet.has(edge.b))
    .map((edge) => normalizeLink(edge.a, edge.aInterface, edge.b, edge.bInterface))
    .sort((left, right) =>
      `${left.local_label}:${left.local_interface}:${left.remote_label}:${left.remote_interface}`.localeCompare(
        `${right.local_label}:${right.local_interface}:${right.remote_label}:${right.remote_interface}`
      )
    );

  const treeRows = tree.discoveredLabels
    .map((label) => ({
      device_label: label,
      id: tree.rowIdByLabel.get(label),
      label,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const treeEdges = Array.from(tree.parentByLabel.entries())
    .map(([childLabel, parentLabel]) => ({
      child_row_id: tree.rowIdByLabel.get(childLabel),
      parent_row_id: tree.rowIdByLabel.get(parentLabel),
    }))
    .sort((left, right) =>
      `${left.parent_row_id}/${left.child_row_id}`.localeCompare(
        `${right.parent_row_id}/${right.child_row_id}`
      )
    );

  const primaryRowByLabel = Object.fromEntries(
    tree.discoveredLabels
      .map((label) => [label, tree.rowIdByLabel.get(label)])
      .sort(([left], [right]) => left.localeCompare(right))
  );

  return {
    devices,
    discovery_status: {
      state: 'ready',
    },
    links,
    primary_row_by_label: primaryRowByLabel,
    tree_edges: treeEdges,
    tree_rows: treeRows,
  };
}

function buildRules(derivedScenario, expectedSnapshot) {
  const leaves = expectedSnapshot.devices
    .map((device) => device.label)
    .filter((label) =>
      !expectedSnapshot.tree_edges.some((edge) => edge.parent_row_id === expectedSnapshot.primary_row_by_label[label])
    )
    .filter((label) => label !== derivedScenario.root);

  const focusLabels =
    derivedScenario.focusLabels ??
    (expectedSnapshot.devices.length <= 18
      ? expectedSnapshot.devices.map((device) => device.label)
      : [
          derivedScenario.root,
          ...expectedSnapshot.devices.slice(1, 6).map((device) => device.label),
          ...expectedSnapshot.devices.slice(-3).map((device) => device.label),
        ]);

  const requiredPaths = leaves.slice(0, 6).map((leafLabel) => {
    const path = [leafLabel];
    let current = leafLabel;

    while (current !== derivedScenario.root) {
      const edge = expectedSnapshot.tree_edges.find(
        (candidate) =>
          candidate.child_row_id === expectedSnapshot.primary_row_by_label[current]
      );
      if (!edge) {
        break;
      }
      const parentLabel = Object.entries(expectedSnapshot.primary_row_by_label).find(
        ([, rowId]) => rowId === edge.parent_row_id
      )?.[0];
      if (!parentLabel) {
        break;
      }
      path.unshift(parentLabel);
      current = parentLabel;
    }

    return path;
  });

  return {
    focus_labels: Array.from(new Set(focusLabels)).sort((left, right) => left.localeCompare(right)),
    required_paths: requiredPaths,
    root_label: derivedScenario.root,
    scenario: derivedScenario.name,
    suites: [derivedScenario.suite],
  };
}

function renderTopologyYaml(derivedScenario) {
  const lines = [
    `name: ${derivedScenario.name}`,
    'mgmt:',
    `  network: clab-${derivedScenario.name}`,
    `  ipv4-subnet: 172.31.${derivedScenario.scenarioIndex}.0/24`,
    'topology:',
    '  defaults:',
    '    kind: linux',
    '    image: lattice/topology-reflection-node:local',
    '    cap-add:',
    '      - NET_ADMIN',
    '      - NET_RAW',
    '    env:',
    '      SNMP_COMMUNITY: public',
    '  nodes:',
  ];

  for (const label of derivedScenario.nodes) {
    const state = derivedScenario.interfaceStateByNode.get(label);
    const interfaceConfig = state.interfaces.map((entry) => `${entry.name}=${entry.cidr}`).join(';');
    const disabledInterfaces = state.interfaces
      .filter((entry) => entry.disabled)
      .map((entry) => entry.name)
      .join(',');

    lines.push(`    ${label}:`);
    lines.push(`      mgmt-ipv4: ${state.mgmtIp}`);
    lines.push('      env:');
    lines.push(`        NODE_SYSNAME: ${label}`);
    lines.push(`        INTERFACE_CONFIG: "${interfaceConfig}"`);
    lines.push(`        DISABLED_INTERFACES: "${disabledInterfaces}"`);
    lines.push(`        DISABLE_SNMP: "${derivedScenario.disabledSnmp.includes(label) ? '1' : '0'}"`);
  }

  lines.push('  links:');
  for (const edge of derivedScenario.derivedLinks) {
    lines.push(
      `    - endpoints: ["${edge.a}:${edge.aInterface}", "${edge.b}:${edge.bInterface}"]`
    );
  }

  return `${lines.join('\n')}\n`;
}

function renderLatticeConfigYaml(derivedScenario, serverPort) {
  const rootState = derivedScenario.interfaceStateByNode.get(derivedScenario.root);
  const lines = [
    'server:',
    '  host: "127.0.0.1"',
    `  port: ${serverPort}`,
    'discovery:',
    '  max_hops: 64',
    '  timeout_seconds: 3',
    '  retries: 1',
    '  concurrent_devices: 1',
    '  auto_discovery_interval_seconds: 300',
    'sources:',
    '  - kind: "snmp"',
    '    version: "2c"',
    '    community: "public"',
    '    seeds:',
    `      - ip: "${rootState.mgmtIp}"`,
    `        label: "${derivedScenario.root}"`,
  ];

  return `${lines.join('\n')}\n`;
}

export function deriveScenario(name, options = {}) {
  const serverPort = options.serverPort ?? 18080;
  const scenarioEntry = getScenario(name);
  const topology = buildTopologyShape(scenarioEntry);
  const derivedScenario = {
    ...scenarioEntry,
    derivedLinks: topology.links,
    interfaceStateByNode: topology.interfaceStateByNode,
  };
  const expectedSnapshot = buildExpectedSnapshot(derivedScenario);
  const rules = buildRules(derivedScenario, expectedSnapshot);

  return {
    derivedScenario,
    expectedSnapshot,
    rules,
    rendered: {
      latticeConfigYaml: renderLatticeConfigYaml(derivedScenario, serverPort),
      topologyYaml: renderTopologyYaml(derivedScenario),
    },
  };
}
