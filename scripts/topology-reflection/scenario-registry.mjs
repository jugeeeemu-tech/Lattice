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
  rootLabels = [root],
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
    rootLabels: [...rootLabels],
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
    rootLabels: ['ring-router-1', 'ring-router-2', 'ring-router-3', 'ring-router-4'],
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
    rootLabels: ['core-router-1', 'core-router-2'],
    links: [
      link('core-router-1', 'dist-switch-a'),
      link('core-router-2', 'dist-switch-a'),
      link('core-router-1', 'dist-switch-b'),
      link('core-router-2', 'dist-switch-b'),
      link('core-router-1', 'dist-switch-c'),
      link('core-router-2', 'dist-switch-c'),
      link('dist-switch-a', 'access-switch-a1'),
      link('dist-switch-a', 'access-switch-a2'),
      link('dist-switch-b', 'access-switch-b1'),
      link('dist-switch-c', 'access-switch-c1'),
      link('access-switch-a1', 'app-server-a'),
      link('access-switch-b1', 'app-server-b'),
      link('access-switch-c1', 'app-server-c'),
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
    rootLabels: ['core-router-1', 'core-router-2'],
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
    rootLabels: ['core-router-1', 'core-router-2'],
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
    rootLabels: ['hub-router-1', 'hub-router-2'],
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
    rootLabels: ['core-router-1', 'core-router-2', 'core-router-4', 'core-router-3'],
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

function buildAdjacencyMap(scenarioEntry) {
  const adjacency = new Map(scenarioEntry.nodes.map((label) => [label, []]));
  for (const edge of scenarioEntry.links) {
    adjacency.get(edge.a)?.push(edge.b);
    adjacency.get(edge.b)?.push(edge.a);
  }

  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) => left.localeCompare(right));
  }

  return adjacency;
}

function buildPrimaryParentMap(scenarioEntry) {
  const adjacency = buildAdjacencyMap(scenarioEntry);
  const queue = [scenarioEntry.root];
  const discovered = new Set([scenarioEntry.root]);
  const parentByLabel = new Map([[scenarioEntry.root, null]]);

  while (queue.length > 0) {
    const current = queue.shift();
    for (const neighbor of adjacency.get(current) ?? []) {
      if (discovered.has(neighbor)) {
        continue;
      }
      discovered.add(neighbor);
      parentByLabel.set(neighbor, current);
      queue.push(neighbor);
    }
  }

  return parentByLabel;
}

function buildChildrenByParentMap(nodes, parentByLabel) {
  const childrenByParent = new Map(nodes.map((label) => [label, []]));
  for (const [label, parentLabel] of parentByLabel.entries()) {
    if (!parentLabel) {
      continue;
    }
    childrenByParent.get(parentLabel)?.push(label);
  }

  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.localeCompare(right));
  }

  return childrenByParent;
}

function buildLanAnchorMap(scenarioEntry, parentByLabel) {
  const childrenByParent = buildChildrenByParentMap(scenarioEntry.nodes, parentByLabel);
  const anchorByLabel = new Map([
    [scenarioEntry.root, inferDeviceRole(scenarioEntry.root) === 'switch' ? scenarioEntry.root : null],
  ]);
  const queue = [scenarioEntry.root];

  while (queue.length > 0) {
    const current = queue.shift();
    const currentRole = inferDeviceRole(current);
    const currentAnchor = anchorByLabel.get(current) ?? null;

    for (const child of childrenByParent.get(current) ?? []) {
      const childRole = inferDeviceRole(child);
      let childAnchor = null;

      if (childRole === 'switch') {
        childAnchor = currentRole === 'switch' && currentAnchor ? currentAnchor : child;
      } else if (childRole === 'server') {
        childAnchor = currentAnchor ?? child;
      } else if (childRole === 'router') {
        childAnchor = currentAnchor ?? null;
      } else {
        childAnchor = currentAnchor ?? null;
      }

      anchorByLabel.set(child, childAnchor);
      queue.push(child);
    }
  }

  return anchorByLabel;
}

function transitSubnetForIndex(scenarioIndex, transitIndex) {
  const secondOctet = 16 + (scenarioIndex % 16);
  const thirdOctet = Math.floor(transitIndex / 64);
  const fourthOctet = (transitIndex % 64) * 4;
  return {
    left: `10.${secondOctet}.${thirdOctet}.${fourthOctet + 1}/30`,
    right: `10.${secondOctet}.${thirdOctet}.${fourthOctet + 2}/30`,
  };
}

function lanSubnetPrefixForIndex(scenarioIndex, lanIndex) {
  const secondOctet = 64 + (scenarioIndex % 16);
  return `10.${secondOctet}.${lanIndex}`;
}

function classifyLinkAddressing(edge, parentByLabel, anchorByLabel) {
  const roleA = inferDeviceRole(edge.a);
  const roleB = inferDeviceRole(edge.b);
  const childLabel =
    parentByLabel.get(edge.a) === edge.b
      ? edge.a
      : parentByLabel.get(edge.b) === edge.a
        ? edge.b
        : null;

  if (roleA === 'router' && roleB === 'router') {
    return { key: `transit:${sortedPair(edge.a, edge.b)}`, type: 'transit' };
  }

  if (childLabel) {
    const treeAnchor = anchorByLabel.get(childLabel) ?? null;
    if (treeAnchor) {
      return { key: `lan:${treeAnchor}`, type: 'lan' };
    }
  }

  const anchorA = anchorByLabel.get(edge.a) ?? null;
  const anchorB = anchorByLabel.get(edge.b) ?? null;
  if (anchorA && anchorA === anchorB) {
    return { key: `lan:${anchorA}`, type: 'lan' };
  }

  if (roleA === 'switch' && roleB === 'switch') {
    return { key: `lan:${sortedPair(edge.a, edge.b)}`, type: 'lan' };
  }

  if (
    (roleA === 'switch' && roleB === 'server') ||
    (roleA === 'server' && roleB === 'switch') ||
    (roleA === 'server' && roleB === 'server')
  ) {
    return { key: `lan:${sortedPair(edge.a, edge.b)}`, type: 'lan' };
  }

  const switchSide =
    roleA === 'switch' ? edge.a : roleB === 'switch' ? edge.b : null;
  if (switchSide) {
    const switchAnchor = anchorByLabel.get(switchSide) ?? null;
    if (switchAnchor) {
      return { key: `lan:${switchAnchor}`, type: 'lan' };
    }
  }

  return { key: `transit:${sortedPair(edge.a, edge.b)}`, type: 'transit' };
}

function mgmtAddressForNode(scenarioIndex, nodeIndex) {
  const thirdOctet = scenarioIndex;
  const fourthOctet = 10 + nodeIndex;
  return `172.31.${thirdOctet}.${fourthOctet}`;
}

function buildTopologyShape(scenarioEntry) {
  const parentByLabel = buildPrimaryParentMap(scenarioEntry);
  const anchorByLabel = buildLanAnchorMap(scenarioEntry, parentByLabel);
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
  const addressDomainByKey = new Map();
  let lanDomainCount = 0;
  let transitDomainCount = 0;

  const links = scenarioEntry.links.map((edge, linkIndex) => {
    const leftState = interfaceStateByNode.get(edge.a);
    const rightState = interfaceStateByNode.get(edge.b);
    if (!leftState || !rightState) {
      throw new Error(`Link references an unknown node: ${edge.a} <-> ${edge.b}`);
    }

    const leftInterface = `eth${leftState.interfaces.length + 1}`;
    const rightInterface = `eth${rightState.interfaces.length + 1}`;
    const linkKey = sortedPair(edge.a, edge.b);
    const disabled = disabledLinkKeys.has(linkKey);
    const addressing = classifyLinkAddressing(edge, parentByLabel, anchorByLabel);
    let domain = addressDomainByKey.get(addressing.key);

    if (!domain) {
      if (addressing.type === 'lan') {
        domain = {
          nextHost: 1,
          prefix: lanSubnetPrefixForIndex(scenarioEntry.scenarioIndex, lanDomainCount),
          prefixLength: 24,
          type: 'lan',
        };
        lanDomainCount += 1;
      } else {
        const transitSubnet = transitSubnetForIndex(
          scenarioEntry.scenarioIndex,
          transitDomainCount
        );
        domain = {
          left: transitSubnet.left,
          right: transitSubnet.right,
          type: 'transit',
        };
        transitDomainCount += 1;
      }
      addressDomainByKey.set(addressing.key, domain);
    }

    const leftCidr =
      domain.type === 'lan'
        ? `${domain.prefix}.${domain.nextHost++}/${domain.prefixLength}`
        : domain.left;
    const rightCidr =
      domain.type === 'lan'
        ? `${domain.prefix}.${domain.nextHost++}/${domain.prefixLength}`
        : domain.right;

    leftState.interfaces.push({
      cidr: leftCidr,
      name: leftInterface,
      peer: edge.b,
      peerInterface: rightInterface,
      disabled,
    });
    rightState.interfaces.push({
      cidr: rightCidr,
      name: rightInterface,
      peer: edge.a,
      peerInterface: leftInterface,
      disabled,
    });

    return {
      a: edge.a,
      aInterface: leftInterface,
      aIp: leftCidr,
      b: edge.b,
      bInterface: rightInterface,
      bIp: rightCidr,
      disabled,
      domainKey: addressing.key,
      domainType: addressing.type,
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

function buildBaseExpectedTree(derivedScenario) {
  const adjacency = adjacencyForScenario(derivedScenario);
  const rootLabels = derivedScenario.rootLabels ?? [derivedScenario.root];
  const queue = [];
  const discovered = new Set();
  const parentByLabel = new Map();
  const depthByLabel = new Map();
  const rowIdByLabel = new Map();

  const enabledRoots = rootLabels.filter((label) => !adjacency.get(label)?.disabledSnmp);
  if (enabledRoots.length === 0) {
    return {
      depthByLabel,
      discoveredLabels: [],
      parentByLabel,
      rowIdByLabel,
    };
  }

  for (const root of enabledRoots) {
    discovered.add(root);
    depthByLabel.set(root, 0);
    rowIdByLabel.set(root, `seed/${root}`);
    queue.push(root);
  }

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

function inferRouterCycleRoots(derivedScenario, visibleLabels) {
  const routerLabels = visibleLabels.filter((label) => inferDeviceRole(label) === 'router');
  const routerSet = new Set(routerLabels);
  const routerAdjacency = new Map(routerLabels.map((label) => [label, []]));

  for (const edge of derivedScenario.derivedLinks) {
    if (edge.disabled) {
      continue;
    }
    if (routerSet.has(edge.a) && routerSet.has(edge.b)) {
      routerAdjacency.get(edge.a)?.push(edge.b);
      routerAdjacency.get(edge.b)?.push(edge.a);
    }
  }

  const visited = new Set();
  const promoted = new Set();

  for (const routerLabel of routerLabels) {
    if (visited.has(routerLabel)) {
      continue;
    }

    const stack = [routerLabel];
    const component = [];
    let edgeCountTwice = 0;
    visited.add(routerLabel);

    while (stack.length > 0) {
      const current = stack.pop();
      component.push(current);
      for (const neighbor of routerAdjacency.get(current) ?? []) {
        edgeCountTwice += 1;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }

    const nodeCount = component.length;
    const edgeCount = Math.floor(edgeCountTwice / 2);
    if (nodeCount >= 2 && edgeCount >= nodeCount) {
      for (const label of component) {
        promoted.add(label);
      }
    }
  }

  return promoted;
}

function inferSharedDownstreamRoots(derivedScenario, visibleLabels) {
  const visibleSet = new Set(visibleLabels);
  const sharedCounts = new Map();

  for (const label of visibleLabels) {
    if (inferDeviceRole(label) === 'router') {
      continue;
    }

    const routerNeighbors = derivedScenario.derivedLinks
      .filter((edge) => !edge.disabled)
      .flatMap((edge) => {
        if (edge.a === label && visibleSet.has(edge.b) && inferDeviceRole(edge.b) === 'router') {
          return [edge.b];
        }
        if (edge.b === label && visibleSet.has(edge.a) && inferDeviceRole(edge.a) === 'router') {
          return [edge.a];
        }
        return [];
      })
      .sort((left, right) => left.localeCompare(right))
      .filter((candidate, index, values) => index === 0 || values[index - 1] !== candidate);

    if (routerNeighbors.length < 2) {
      continue;
    }

    for (let index = 0; index < routerNeighbors.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < routerNeighbors.length; otherIndex += 1) {
        const pairKey = sortedPair(routerNeighbors[index], routerNeighbors[otherIndex]);
        sharedCounts.set(pairKey, (sharedCounts.get(pairKey) ?? 0) + 1);
      }
    }
  }

  const promoted = new Set();
  for (const [pairKey, count] of sharedCounts.entries()) {
    if (count < 2) {
      continue;
    }
    const [left, right] = pairKey.split('::');
    promoted.add(left);
    promoted.add(right);
  }

  return promoted;
}

function inferSharedChildrenByRoot(derivedScenario, visibleLabels, rootLabels) {
  const visibleSet = new Set(visibleLabels);
  const rootSet = new Set(rootLabels.filter((label) => inferDeviceRole(label) === 'router'));
  const rootsByChild = new Map();

  for (const edge of derivedScenario.derivedLinks) {
    if (edge.disabled) {
      continue;
    }

    const [rootLabel, childLabel] = rootSet.has(edge.a)
      ? [edge.a, edge.b]
      : rootSet.has(edge.b)
        ? [edge.b, edge.a]
        : [null, null];

    if (!rootLabel || !childLabel || !visibleSet.has(childLabel) || inferDeviceRole(childLabel) === 'router') {
      continue;
    }

    const current = rootsByChild.get(childLabel) ?? [];
    current.push(rootLabel);
    rootsByChild.set(childLabel, current);
  }

  const sharedChildrenByRoot = new Map();
  for (const [childLabel, rootCandidates] of rootsByChild.entries()) {
    const uniqueRoots = [...new Set(rootCandidates)].sort((left, right) => left.localeCompare(right));
    if (uniqueRoots.length < 2) {
      continue;
    }
    for (const rootLabel of uniqueRoots) {
      const current = sharedChildrenByRoot.get(rootLabel) ?? [];
      current.push(childLabel);
      sharedChildrenByRoot.set(rootLabel, current);
    }
  }

  for (const [rootLabel, children] of sharedChildrenByRoot.entries()) {
    sharedChildrenByRoot.set(
      rootLabel,
      [...new Set(children)].sort((left, right) => left.localeCompare(right))
    );
  }

  return sharedChildrenByRoot;
}

function buildDisplayExpectedTree(derivedScenario) {
  const baseTree = buildBaseExpectedTree(derivedScenario);
  const adjacency = adjacencyForScenario(derivedScenario);
  const discoveredSet = new Set(baseTree.discoveredLabels);
  const fallbackParentByLabel = new Map(
    derivedScenario.disabledSnmp
      .filter((label) => !discoveredSet.has(label))
      .map((label) => {
        const candidateParents = Array.from(
          new Set(
            (adjacency.get(label)?.edges ?? [])
              .map((edge) => edge.peer)
              .filter((peer) => discoveredSet.has(peer))
          )
        ).sort((left, right) => left.localeCompare(right));
        return [label, candidateParents.length === 1 ? candidateParents[0] : null];
      })
  );
  const visibleDisabledLabels = Array.from(fallbackParentByLabel.keys()).sort((left, right) =>
    left.localeCompare(right)
  );
  const visibleLabels = [...baseTree.discoveredLabels, ...visibleDisabledLabels];
  const visibleSet = new Set(visibleLabels);
  const baseParentByLabel = new Map(baseTree.parentByLabel);
  for (const [label, parentLabel] of fallbackParentByLabel.entries()) {
    if (parentLabel) {
      baseParentByLabel.set(label, parentLabel);
    }
  }

  const explicitRootLabels = (derivedScenario.rootLabels ?? [derivedScenario.root]).filter((label) =>
    visibleSet.has(label)
  );
  const explicitRoots = new Set(explicitRootLabels);
  const parentByLabel = new Map(
    Array.from(baseParentByLabel.entries()).filter(([label]) => !explicitRoots.has(label))
  );
  const inferredRootLabels = visibleLabels
    .filter((label) => !explicitRoots.has(label) && !parentByLabel.has(label))
    .sort((left, right) => left.localeCompare(right));
  const rootLabels = [...explicitRootLabels, ...inferredRootLabels];
  const childrenByParent = buildChildrenByParentMap(visibleLabels, parentByLabel);
  const sharedChildrenByRoot = inferSharedChildrenByRoot(derivedScenario, visibleLabels, rootLabels);

  const rows = [];

  function emit(label, parentRowId = null, depth = 0) {
    const rowId = parentRowId ? `${parentRowId}/${label}` : `seed/${label}`;
    rows.push({
      depth,
      device_label: label,
      id: rowId,
      label,
      parent_row_id: parentRowId,
    });
    for (const childLabel of childrenByParent.get(label) ?? []) {
      emit(childLabel, rowId, depth + 1);
    }
  }

  function emitDuplicate(label, parentRowId, parentDepth) {
    const rowId = `${parentRowId}/${label}`;
    rows.push({
      depth: parentDepth + 1,
      device_label: label,
      id: rowId,
      label,
      parent_row_id: parentRowId,
    });
    for (const childLabel of childrenByParent.get(label) ?? []) {
      emitDuplicate(childLabel, rowId, parentDepth + 1);
    }
  }

  for (const rootLabel of rootLabels) {
    emit(rootLabel, null, 0);
  }

  for (const rootLabel of rootLabels) {
    for (const childLabel of sharedChildrenByRoot.get(rootLabel) ?? []) {
      if (parentByLabel.get(childLabel) === rootLabel) {
        continue;
      }
      emitDuplicate(childLabel, `seed/${rootLabel}`, 0);
    }
  }

  rows.sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id));

  const primaryRowByLabel = {};
  const primaryDepthByLabel = new Map();
  const rootRankByLabel = new Map(rootLabels.map((label, index) => [label, index]));

  function rootLabelForRowId(rowId) {
    const [, rootLabel] = rowId.match(/^seed\/([^/]+)/) ?? [];
    return rootLabel ?? null;
  }

  for (const row of rows) {
    const rowRootLabel = rootLabelForRowId(row.id);
    const rowRootRank = rowRootLabel ? rootRankByLabel.get(rowRootLabel) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    const currentDepth = primaryDepthByLabel.get(row.label);
    const currentRowId = primaryRowByLabel[row.label];
    const currentRootLabel = currentRowId ? rootLabelForRowId(currentRowId) : null;
    const currentRootRank = currentRootLabel
      ? rootRankByLabel.get(currentRootLabel) ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER;
    if (
      currentDepth === undefined ||
      row.depth < currentDepth ||
      (row.depth === currentDepth &&
        (rowRootRank < currentRootRank ||
          (rowRootRank === currentRootRank && row.id.localeCompare(currentRowId) < 0)))
    ) {
      primaryDepthByLabel.set(row.label, row.depth);
      primaryRowByLabel[row.label] = row.id;
    }
  }

  return {
    parentByLabel,
    primaryRowByLabel,
    rootLabels,
    rows,
    sharedChildrenByRoot,
    visibleLabels: [...visibleSet].sort((left, right) => left.localeCompare(right)),
  };
}

function buildExpectedRelations(displayTree, derivedScenario) {
  const visibleLabels = displayTree.visibleLabels;
  const visibleSet = new Set(visibleLabels);
  const byLabel = Object.fromEntries(
    visibleLabels.map((label) => [
      label,
      {
        parents: [],
        peers: [],
        children: [],
      },
    ])
  );

  const addParentChild = (parentLabel, childLabel) => {
    if (!visibleSet.has(parentLabel) || !visibleSet.has(childLabel) || parentLabel === childLabel) {
      return;
    }

    byLabel[childLabel].parents.push(parentLabel);
    byLabel[parentLabel].children.push(childLabel);
  };

  for (const [childLabel, parentLabel] of displayTree.parentByLabel.entries()) {
    if (parentLabel) {
      addParentChild(parentLabel, childLabel);
    }
  }

  for (const [rootLabel, childLabels] of displayTree.sharedChildrenByRoot.entries()) {
    for (const childLabel of childLabels) {
      addParentChild(rootLabel, childLabel);
    }
  }

  const rootSet = new Set(displayTree.rootLabels);
  for (const edge of derivedScenario.derivedLinks) {
    if (edge.disabled || !rootSet.has(edge.a) || !rootSet.has(edge.b) || edge.a === edge.b) {
      continue;
    }

    byLabel[edge.a].peers.push(edge.b);
    byLabel[edge.b].peers.push(edge.a);
  }

  return Object.fromEntries(
    Object.entries(byLabel)
      .map(([label, relations]) => [
        label,
        {
          parents: [...new Set(relations.parents)].sort((left, right) => left.localeCompare(right)),
          peers: [...new Set(relations.peers)].sort((left, right) => left.localeCompare(right)),
          children: [...new Set(relations.children)].sort((left, right) => left.localeCompare(right)),
        },
      ])
      .sort(([left], [right]) => left.localeCompare(right))
  );
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
  const displayTree = buildDisplayExpectedTree(derivedScenario);
  const visibleLabels = displayTree.visibleLabels;
  const visibleSet = new Set(visibleLabels);

  const devices = visibleLabels
    .map((label) => ({
      depth: displayTree.rows
        .filter((row) => row.label === label)
        .reduce((best, row) => Math.min(best, row.depth), Number.POSITIVE_INFINITY),
      deployment_type: 'unknown',
      device_role: inferDeviceRole(label),
      label,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  const links = derivedScenario.derivedLinks
    .filter((edge) => !edge.disabled)
    .filter((edge) => visibleSet.has(edge.a) && visibleSet.has(edge.b))
    .map((edge) => normalizeLink(edge.a, edge.aInterface, edge.b, edge.bInterface))
    .sort((left, right) =>
      `${left.local_label}:${left.local_interface}:${left.remote_label}:${left.remote_interface}`.localeCompare(
        `${right.local_label}:${right.local_interface}:${right.remote_label}:${right.remote_interface}`
      )
    );

  const treeRows = displayTree.rows
    .map((row) => ({
      device_label: row.device_label,
      id: row.id,
      label: row.label,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const treeEdges = displayTree.rows
    .filter((row) => row.parent_row_id)
    .map((row) => ({
      child_row_id: row.id,
      parent_row_id: row.parent_row_id,
    }))
    .sort((left, right) =>
      `${left.parent_row_id}/${left.child_row_id}`.localeCompare(
        `${right.parent_row_id}/${right.child_row_id}`
      )
    );

  const primaryRowByLabel = Object.fromEntries(
    Object.entries(displayTree.primaryRowByLabel).sort(([left], [right]) => left.localeCompare(right))
  );
  const rootDeviceLabels = [...displayTree.rootLabels].sort((left, right) => left.localeCompare(right));
  const deviceRelationsByLabel = buildExpectedRelations(displayTree, derivedScenario);

  return {
    device_relations_by_label: deviceRelationsByLabel,
    devices,
    discovery_status: {
      state: 'ready',
    },
    links,
    primary_row_by_label: primaryRowByLabel,
    root_device_labels: rootDeviceLabels,
    tree_edges: treeEdges,
    tree_rows: treeRows,
  };
}

function buildRules(derivedScenario, expectedSnapshot) {
  const rootLabels = new Set(derivedScenario.rootLabels ?? [derivedScenario.root]);
  const leaves = expectedSnapshot.devices
    .map((device) => device.label)
    .filter((label) =>
      !expectedSnapshot.tree_edges.some((edge) => edge.parent_row_id === expectedSnapshot.primary_row_by_label[label])
    )
    .filter((label) => !rootLabels.has(label));

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

    while (!rootLabels.has(current)) {
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

    return rootLabels.has(current) ? path : null;
  }).filter((path) => Array.isArray(path));

  return {
    focus_labels: Array.from(new Set([...(derivedScenario.rootLabels ?? [derivedScenario.root]), ...focusLabels])).sort(
      (left, right) => left.localeCompare(right)
    ),
    required_paths: requiredPaths,
    root_label: derivedScenario.root,
    scenario: derivedScenario.name,
    suites: [derivedScenario.suite],
  };
}

function buildMetadata(derivedScenario) {
  const expectedNeighborCountByLabel = new Map(derivedScenario.nodes.map((label) => [label, 0]));

  for (const edge of derivedScenario.derivedLinks) {
    if (edge.disabled) {
      continue;
    }
    expectedNeighborCountByLabel.set(
      edge.a,
      (expectedNeighborCountByLabel.get(edge.a) ?? 0) + 1
    );
    expectedNeighborCountByLabel.set(
      edge.b,
      (expectedNeighborCountByLabel.get(edge.b) ?? 0) + 1
    );
  }

  return {
    name: derivedScenario.name,
    nodes: derivedScenario.nodes
      .map((label) => {
        const state = derivedScenario.interfaceStateByNode.get(label);
        if (!state) {
          throw new Error(`Missing interface state for ${label}`);
        }

        return {
          expected_neighbor_count: expectedNeighborCountByLabel.get(label) ?? 0,
          label,
          mgmt_ip: state.mgmtIp,
          snmp_enabled: !derivedScenario.disabledSnmp.includes(label),
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label)),
    root: derivedScenario.root,
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
    '  auto_discovery_interval_seconds: 3',
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
  const metadata = buildMetadata(derivedScenario);
  const rules = buildRules(derivedScenario, expectedSnapshot);

  return {
    derivedScenario,
    expectedSnapshot,
    metadata,
    rules,
    rendered: {
      latticeConfigYaml: renderLatticeConfigYaml(derivedScenario, serverPort),
      topologyYaml: renderTopologyYaml(derivedScenario),
    },
  };
}
