#!/usr/bin/env bash
set -euo pipefail

NODE_SYSNAME="${NODE_SYSNAME:-$(hostname -s)}"
INTERFACE_CONFIG="${INTERFACE_CONFIG:-}"
DISABLED_INTERFACES="${DISABLED_INTERFACES:-}"
DISABLE_SNMP="${DISABLE_SNMP:-0}"
SNMP_COMMUNITY="${SNMP_COMMUNITY:-public}"
SYS_DESCR="${SYS_DESCR:-Linux ${NODE_SYSNAME}}"

wait_for_interface() {
  local iface="$1"
  local attempts="${2:-60}"

  for _ in $(seq 1 "${attempts}"); do
    if ip link show "${iface}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  return 1
}

wait_for_path() {
  local target_path="$1"
  local attempts="${2:-60}"

  for _ in $(seq 1 "${attempts}"); do
    if [[ -e "${target_path}" ]]; then
      return 0
    fi
    sleep 0.5
  done

  return 1
}

hostname "${NODE_SYSNAME}" || true

declare -a active_interfaces=()

if [[ -n "${INTERFACE_CONFIG}" ]]; then
  IFS=';' read -r -a interface_entries <<<"${INTERFACE_CONFIG}"
  for entry in "${interface_entries[@]}"; do
    [[ -z "${entry}" ]] && continue
    iface="${entry%%=*}"
    cidr="${entry#*=}"
    wait_for_interface "${iface}"
    ip link set "${iface}" up
    ip addr flush dev "${iface}" >/dev/null 2>&1 || true
    ip addr add "${cidr}" dev "${iface}"
    active_interfaces+=("${iface}")
  done
fi

if [[ -n "${DISABLED_INTERFACES}" ]]; then
  IFS=',' read -r -a disabled_entries <<<"${DISABLED_INTERFACES}"
  for iface in "${disabled_entries[@]}"; do
    [[ -z "${iface}" ]] && continue
    ip link set "${iface}" down || true
    filtered=()
    for candidate in "${active_interfaces[@]}"; do
      if [[ "${candidate}" != "${iface}" ]]; then
        filtered+=("${candidate}")
      fi
    done
    active_interfaces=("${filtered[@]}")
  done
fi

mkdir -p /var/agentx /var/run/lldpd

cat >/etc/snmp/snmpd.conf <<EOF
agentaddress udp:161
rocommunity ${SNMP_COMMUNITY}
sysName ${NODE_SYSNAME}
sysDescr ${SYS_DESCR}
master agentx
agentXSocket /var/agentx/master
EOF

if [[ "${DISABLE_SNMP}" == "1" ]]; then
  if [[ "${#active_interfaces[@]}" -gt 0 ]]; then
    interface_pattern="$(IFS=,; printf '%s' "${active_interfaces[*]}")"
    lldpd -I "${interface_pattern}"
  else
    lldpd
  fi
  exec tail -f /dev/null
fi

snmpd -f -Lo -C -c /etc/snmp/snmpd.conf &
SNMPD_PID=$!

wait_for_path /var/agentx/master

if [[ "${#active_interfaces[@]}" -gt 0 ]]; then
  interface_pattern="$(IFS=,; printf '%s' "${active_interfaces[*]}")"
  lldpd -x -I "${interface_pattern}"
else
  lldpd -x
fi

wait "${SNMPD_PID}"
