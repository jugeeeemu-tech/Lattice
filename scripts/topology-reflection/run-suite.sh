#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <suite> [scenario]" >&2
  exit 1
fi

SUITE="$1"
SCENARIO_OVERRIDE="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ARTIFACT_DIR="${TOPOLOGY_REFLECTION_ARTIFACT_DIR:-${ROOT_DIR}/artifacts/topology-reflection}"
SERVER_PORT="${TOPOLOGY_REFLECTION_SERVER_PORT:-18080}"
STATUS=0

mkdir -p "${ARTIFACT_DIR}"

if [[ -z "${SCENARIO_OVERRIDE}" ]]; then
  mapfile -t SCENARIOS < <(node "${SCRIPT_DIR}/render-scenario.mjs" --list-suite "${SUITE}")
else
  SCENARIOS=("${SCENARIO_OVERRIDE}")
fi

if [[ "${#SCENARIOS[@]}" -eq 0 ]]; then
  echo "No scenarios were defined for suite '${SUITE}'." >&2
  exit 1
fi

for scenario in "${SCENARIOS[@]}"; do
  scenario_output="${ARTIFACT_DIR}/${scenario}"
  rm -rf "${scenario_output}"
  mkdir -p "${scenario_output}"

  if ! "${SCRIPT_DIR}/run-scenario.sh" "${scenario}" "${scenario_output}" "${SERVER_PORT}"; then
    STATUS=1
  fi
done

exit "${STATUS}"
