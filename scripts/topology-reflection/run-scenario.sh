#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <scenario> <output-dir> [server-port]" >&2
  exit 1
fi

SCENARIO="$1"
OUTPUT_DIR="$2"
SERVER_PORT="${3:-18080}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
FRONTEND_DIR="${ROOT_DIR}/crates/lattice-server/frontend"
SERVER_BIN="${ROOT_DIR}/target/debug/lattice"
RENDER_SCRIPT="${SCRIPT_DIR}/render-scenario.mjs"
COMPARE_SCRIPT="${SCRIPT_DIR}/compare-snapshot.mjs"
IMAGE_TAG="${TOPOLOGY_REFLECTION_IMAGE_TAG:-lattice/topology-reflection-node:local}"
SCENARIO_DIR="${OUTPUT_DIR}/scenario"
SERVER_LOG="${OUTPUT_DIR}/lattice-server.log"
ACTUAL_SNAPSHOT="${OUTPUT_DIR}/actual.snapshot.json"
SCREENSHOT_PATH="${OUTPUT_DIR}/topology.png"
TOPOLOGY_FILE="${SCENARIO_DIR}/topology.clab.yml"
CONFIG_FILE="${SCENARIO_DIR}/lattice.ci.yaml"
EXPECTED_SNAPSHOT="${SCENARIO_DIR}/expected.snapshot.json"
EXPECTED_RULES="${SCENARIO_DIR}/expected.rules.json"
SCENARIO_METADATA="${SCENARIO_DIR}/scenario.metadata.json"

mkdir -p "${OUTPUT_DIR}"

collect_root_diagnostics() {
  if [[ ! -f "${SCENARIO_METADATA}" ]]; then
    return 0
  fi

  local labels
  local root_label
  labels="$(
    node --input-type=module - "${SCENARIO_METADATA}" <<'EOF'
import { readFile } from 'node:fs/promises';

const [metadataPath] = process.argv.slice(2);
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
for (const node of metadata.nodes ?? []) {
  process.stdout.write(`${node.label ?? ''}\n`);
}
EOF
  )"
  root_label="$(
    node --input-type=module - "${SCENARIO_METADATA}" <<'EOF'
import { readFile } from 'node:fs/promises';

const [metadataPath] = process.argv.slice(2);
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
process.stdout.write(`${metadata.root ?? ''}\n`);
EOF
  )"

  if [[ -z "${labels}" ]]; then
    return 0
  fi

  while IFS= read -r label; do
    [[ -z "${label}" ]] && continue

    local diagnostics_dir="${OUTPUT_DIR}/node-diagnostics/${label}"
    local container_name="clab-${SCENARIO}-${label}"
    mkdir -p "${diagnostics_dir}"

    docker exec "${container_name}" hostname \
      >"${diagnostics_dir}/hostname.txt" 2>&1 || true
    docker exec "${container_name}" sh -lc 'ip -o -4 addr show' \
      >"${diagnostics_dir}/ip-addresses.txt" 2>&1 || true
    docker exec "${container_name}" lldpcli -f keyvalue show neighbors details \
      >"${diagnostics_dir}/lldp-neighbors.txt" 2>&1 || true
    docker exec "${container_name}" lldpcli -f keyvalue show interfaces details \
      >"${diagnostics_dir}/lldp-interfaces.txt" 2>&1 || true
    docker exec "${container_name}" snmpwalk -v2c -c public -On -OQUs localhost 1.0.8802.1.1.2.1.4.1.1.9 \
      >"${diagnostics_dir}/snmp-lldp-remote-sysname.txt" 2>&1 || true
    docker exec "${container_name}" snmpwalk -v2c -c public -On -OQUs localhost 1.0.8802.1.1.2.1.4.2.1.3 \
      >"${diagnostics_dir}/snmp-lldp-remote-mgmt.txt" 2>&1 || true
    docker exec "${container_name}" snmpwalk -v2c -c public -On -OQUs localhost 1.0.8802.1.1.2.1.3 \
      >"${diagnostics_dir}/snmp-lldp-local.txt" 2>&1 || true

    if [[ "${label}" == "${root_label}" ]]; then
      mkdir -p "${OUTPUT_DIR}/root-diagnostics"
      cp "${diagnostics_dir}/"*.txt "${OUTPUT_DIR}/root-diagnostics/" 2>/dev/null || true
    fi
  done <<<"${labels}"
}

cleanup() {
  local exit_code=$?

  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi

  if [[ -f "${TOPOLOGY_FILE}" ]]; then
    collect_root_diagnostics || true
    containerlab inspect -t "${TOPOLOGY_FILE}" >"${OUTPUT_DIR}/containerlab-inspect.txt" 2>&1 || true
    containerlab destroy -t "${TOPOLOGY_FILE}" --cleanup >"${OUTPUT_DIR}/containerlab-destroy.log" 2>&1 || true
  fi

  return "${exit_code}"
}

trap cleanup EXIT

node "${RENDER_SCRIPT}" --scenario "${SCENARIO}" --out "${SCENARIO_DIR}" --server-port "${SERVER_PORT}"

if ! docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
  docker build -t "${IMAGE_TAG}" "${ROOT_DIR}/tests/topology-reflection/image"
fi

containerlab deploy -t "${TOPOLOGY_FILE}" --reconfigure >"${OUTPUT_DIR}/containerlab-deploy.log" 2>&1

node --input-type=module - "${SCENARIO_METADATA}" "${SCENARIO}" >"${OUTPUT_DIR}/topology-preflight.log" 2>&1 <<'EOF'
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const [metadataPath, scenarioName] = process.argv.slice(2);
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
const checks = metadata.nodes.filter((node) => node.snmp_enabled);
const rootLabel = metadata.root;
const lldpSysNameOid = '1.0.8802.1.1.2.1.4.1.1.9';
const sysDescrOid = '1.3.6.1.2.1.1.1.0';
const maxAttempts = 150;
const sleepMs = 1_000;
const stableReadyTarget = 3;
let stableReadyIterations = 0;
let previousSignature = null;

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stderr, stdout });
    });
  });
}

async function snmpLineCount(containerName, oid) {
  const result = await run('docker', [
    'exec',
    containerName,
    'snmpwalk',
    '-v2c',
    '-c',
    'public',
    '-On',
    '-Oqv',
    '-t',
    '1',
    '-r',
    '0',
    'localhost',
    oid,
  ]);

  if (result.code !== 0) {
    return null;
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean).length;
}

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const statusByNode = await Promise.all(
    checks.map(async (node) => {
      const containerName = `clab-${scenarioName}-${node.label}`;
      const sysDescrCount = await snmpLineCount(containerName, sysDescrOid);
      const lldpNeighborCount =
        sysDescrCount === null ? null : await snmpLineCount(containerName, lldpSysNameOid);

      return {
        expected_neighbor_count: node.expected_neighbor_count,
        label: node.label,
        lldp_ready:
          node.expected_neighbor_count === 0 ||
          (lldpNeighborCount !== null && lldpNeighborCount >= node.expected_neighbor_count),
        lldp_neighbor_count: lldpNeighborCount,
        snmp_ready: sysDescrCount !== null,
      };
    })
  );
  const rootStatus = statusByNode.find((node) => node.label === rootLabel);
  const snmpReady = statusByNode.every((node) => node.snmp_ready);
  const lldpReady = statusByNode.every((node) => node.lldp_ready);
  const ready = snmpReady && lldpReady;
  const signature = JSON.stringify(
    statusByNode.map((node) => ({
      label: node.label,
      lldp_neighbor_count: node.lldp_neighbor_count,
      snmp_ready: node.snmp_ready,
    }))
  );
  stableReadyIterations = ready && signature === previousSignature ? stableReadyIterations + 1 : ready ? 1 : 0;
  previousSignature = signature;

  console.log(
    JSON.stringify(
      {
        attempt,
        lldp_ready: lldpReady,
        nodes: statusByNode,
        ready,
        root_label: rootLabel,
        root_lldp_ready: rootStatus ? rootStatus.lldp_ready : true,
        snmp_ready: snmpReady,
        stable_ready_iterations: stableReadyIterations,
      },
      null,
      2
    )
  );

  if (ready && stableReadyIterations >= stableReadyTarget) {
    process.exit(0);
  }

  await new Promise((resolve) => setTimeout(resolve, sleepMs));
}

throw new Error(`Topology preflight did not converge for scenario ${scenarioName}.`);
EOF

"${SERVER_BIN}" serve --config "${CONFIG_FILE}" --host 127.0.0.1 --port "${SERVER_PORT}" >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

server_healthy=0
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error "http://127.0.0.1:${SERVER_PORT}/health" >/dev/null 2>&1; then
    server_healthy=1
    break
  fi
  if ! kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

if [[ "${server_healthy}" -ne 1 ]]; then
  echo "lattice-server did not become healthy on port ${SERVER_PORT}" >&2
  exit 1
fi

node --input-type=module - "${SERVER_PORT}" "${ACTUAL_SNAPSHOT}" "${EXPECTED_SNAPSHOT}" <<'EOF'
import { readFile, writeFile } from 'node:fs/promises';

const [port, outputPath, expectedPath] = process.argv.slice(2);
const expectedSnapshot = JSON.parse(await readFile(expectedPath, 'utf8'));
const expectedDeviceCount = expectedSnapshot.devices.length;
const expectedLinkCount = expectedSnapshot.links.length;
const expectedTreeRowCount = expectedSnapshot.tree_rows.length;
const expectedTreeEdgeCount = expectedSnapshot.tree_edges.length;
const maxAttempts = 20;
const sleepMs = 2_000;
const stableReadyTarget = 3;
let snapshot = null;
let previousReadySignature = null;
let stableReadyIterations = 0;

function readySignature(candidate) {
  const deviceLabels = Array.isArray(candidate.devices)
    ? candidate.devices
        .map((device) => device.label ?? device.id ?? 'unknown')
        .sort((left, right) => left.localeCompare(right))
    : [];
  return JSON.stringify({
    device_labels: deviceLabels,
    link_count: Array.isArray(candidate.links) ? candidate.links.length : 0,
    tree_edge_count: Array.isArray(candidate.tree_edges) ? candidate.tree_edges.length : 0,
    tree_row_count: Array.isArray(candidate.tree_rows) ? candidate.tree_rows.length : 0,
  });
}

for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
  const response = await fetch(`http://127.0.0.1:${port}/api/topology`, {
    headers: { Accept: 'application/json' },
  }).catch(() => null);

  if (response?.ok) {
    snapshot = await response.json();
    const state = snapshot?.discovery_status?.state ?? '';
    const converged =
      Array.isArray(snapshot.devices) &&
      Array.isArray(snapshot.links) &&
      Array.isArray(snapshot.tree_rows) &&
      Array.isArray(snapshot.tree_edges) &&
      snapshot.devices.length >= expectedDeviceCount &&
      snapshot.links.length >= expectedLinkCount &&
      snapshot.tree_rows.length >= expectedTreeRowCount &&
      snapshot.tree_edges.length >= expectedTreeEdgeCount;

    if (state === 'ready') {
      const signature = readySignature(snapshot);
      stableReadyIterations =
        signature === previousReadySignature ? stableReadyIterations + 1 : 1;
      previousReadySignature = signature;
    } else {
      stableReadyIterations = 0;
      previousReadySignature = null;
    }

    console.log(
      JSON.stringify(
        {
          attempt: attempt + 1,
          converged,
          device_count: Array.isArray(snapshot.devices) ? snapshot.devices.length : 0,
          link_count: Array.isArray(snapshot.links) ? snapshot.links.length : 0,
          stable_ready_iterations: stableReadyIterations,
          state,
          tree_edge_count: Array.isArray(snapshot.tree_edges) ? snapshot.tree_edges.length : 0,
          tree_row_count: Array.isArray(snapshot.tree_rows) ? snapshot.tree_rows.length : 0,
        },
        null,
        2
      )
    );

    if (
      state === 'failed' ||
      (state === 'ready' && (converged || stableReadyIterations >= stableReadyTarget))
    ) {
      break;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, sleepMs));
}

if (!snapshot) {
  throw new Error(`Did not receive a topology snapshot from port ${port}.`);
}

await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
EOF

node "${COMPARE_SCRIPT}" --actual "${ACTUAL_SNAPSHOT}" --expected "${EXPECTED_SNAPSHOT}" --out-dir "${OUTPUT_DIR}"

(
  cd "${FRONTEND_DIR}"
  PLAYWRIGHT_BASE_URL="http://127.0.0.1:${SERVER_PORT}" \
    PLAYWRIGHT_BROWSER_CHANNEL="${PLAYWRIGHT_BROWSER_CHANNEL:-chrome}" \
    PLAYWRIGHT_EXTERNAL_SERVER=1 \
    TOPOLOGY_REFLECTION_EXPECTED_SNAPSHOT_PATH="${EXPECTED_SNAPSHOT}" \
    TOPOLOGY_REFLECTION_RULES_PATH="${EXPECTED_RULES}" \
    TOPOLOGY_REFLECTION_SCREENSHOT_PATH="${SCREENSHOT_PATH}" \
    TOPOLOGY_REFLECTION_SCENARIO="${SCENARIO}" \
    npx playwright test tests/e2e/topology-reflection.spec.ts --project=chromium
)
