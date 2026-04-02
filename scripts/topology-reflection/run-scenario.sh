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

cleanup() {
  local exit_code=$?

  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi

  if [[ -f "${TOPOLOGY_FILE}" ]]; then
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
const maxAttempts = 90;
const sleepMs = 1_000;

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
          (lldpNeighborCount !== null && lldpNeighborCount >= 1),
        lldp_neighbor_count: lldpNeighborCount,
        snmp_ready: sysDescrCount !== null,
      };
    })
  );
  const rootStatus = statusByNode.find((node) => node.label === rootLabel);
  const snmpReady = statusByNode.every((node) => node.snmp_ready);
  const rootLldpReady = rootStatus ? rootStatus.lldp_ready : true;
  const ready = snmpReady && rootLldpReady;

  console.log(
    JSON.stringify(
      {
        attempt,
        nodes: statusByNode,
        ready,
        root_label: rootLabel,
        root_lldp_ready: rootLldpReady,
        snmp_ready: snmpReady,
      },
      null,
      2
    )
  );

  if (ready) {
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

node --input-type=module - "${SERVER_PORT}" "${ACTUAL_SNAPSHOT}" <<'EOF'
import { writeFile } from 'node:fs/promises';

const [port, outputPath] = process.argv.slice(2);
let snapshot = null;

for (let attempt = 0; attempt < 60; attempt += 1) {
  const response = await fetch(`http://127.0.0.1:${port}/api/topology`, {
    headers: { Accept: 'application/json' },
  }).catch(() => null);

  if (response?.ok) {
    snapshot = await response.json();
    if (
      Array.isArray(snapshot.devices) &&
      ['ready', 'failed'].includes(snapshot?.discovery_status?.state ?? '')
    ) {
      break;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 2_000));
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
