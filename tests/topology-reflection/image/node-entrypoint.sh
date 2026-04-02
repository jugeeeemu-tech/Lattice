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

wait_for_carrier() {
  local iface="$1"
  local attempts="${2:-60}"
  local carrier_path="/sys/class/net/${iface}/carrier"

  if [[ ! -e "${carrier_path}" ]]; then
    return 0
  fi

  for _ in $(seq 1 "${attempts}"); do
    if [[ "$(cat "${carrier_path}" 2>/dev/null || echo 0)" == "1" ]]; then
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

wait_for_socket() {
  local socket_path="$1"
  local attempts="${2:-40}"

  for _ in $(seq 1 "${attempts}"); do
    if [[ -S "${socket_path}" ]]; then
      return 0
    fi
    sleep 0.25
  done

  return 1
}

management_ipv4() {
  ip -o -4 addr show dev eth0 scope global 2>/dev/null \
    | awk '{print $4}' \
    | cut -d/ -f1 \
    | head -n 1
}

start_lldpd() {
  local snmp_enabled="$1"
  local mgmt_ip="${2:-}"
  local -a args=()

  if [[ "${snmp_enabled}" == "1" ]]; then
    args+=(-x)
  fi

  if [[ "${#active_interfaces[@]}" -gt 0 ]]; then
    interface_pattern="$(IFS=,; printf '%s' "${active_interfaces[*]}")"
    args+=(-I "${interface_pattern}")
  fi

  if [[ -n "${mgmt_ip}" ]]; then
    args+=(-m "${mgmt_ip}")
  fi

  mkdir -p /var/log/topology-reflection

  for _ in $(seq 1 5); do
    pkill -x lldpd >/dev/null 2>&1 || true
    rm -f /run/lldpd.socket /var/run/lldpd.socket

    lldpd -d "${args[@]}" >/var/log/topology-reflection/lldpd.log 2>&1 &
    local lldpd_pid=$!

    if wait_for_socket /run/lldpd.socket 20 || wait_for_socket /var/run/lldpd.socket 20; then
      return 0
    fi

    kill "${lldpd_pid}" >/dev/null 2>&1 || true
    wait "${lldpd_pid}" >/dev/null 2>&1 || true
    sleep 1
  done

  return 1
}

configure_lldpd() {
  local attempts="${1:-20}"
  local interface_pattern=""

  for _ in $(seq 1 "${attempts}"); do
    if lldpcli configure lldp tx-interval 5 >/dev/null 2>&1; then
      lldpcli configure lldp tx-hold 10 >/dev/null 2>&1 || true
      lldpcli configure lldp portidsubtype ifname >/dev/null 2>&1 || true
      lldpcli configure lldp portdescription-source ifname >/dev/null 2>&1 || true
      lldpcli configure system interface promiscuous >/dev/null 2>&1 || true
      if [[ "${#active_interfaces[@]}" -gt 0 ]]; then
        interface_pattern="$(IFS=,; printf '%s' "${active_interfaces[*]}")"
        lldpcli configure ports "${interface_pattern}" lldp status rx-and-tx >/dev/null 2>&1 || true
      fi
      lldpcli configure lldp management-addresses-advertisements >/dev/null 2>&1 || true
      lldpcli update >/dev/null 2>&1 || true
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
    ip link set "${iface}" promisc on multicast on || true
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

for iface in "${active_interfaces[@]}"; do
  [[ -z "${iface}" ]] && continue
  wait_for_carrier "${iface}" 20 || true
done

mkdir -p /var/agentx /var/run/lldpd

MGMT_IP="$(management_ipv4)"

cat >/etc/snmp/snmpd.conf <<EOF
agentaddress udp:161
rocommunity ${SNMP_COMMUNITY}
sysName ${NODE_SYSNAME}
sysDescr ${SYS_DESCR}
master agentx
agentXSocket /var/agentx/master
EOF

if [[ "${DISABLE_SNMP}" == "1" ]]; then
  start_lldpd 0 "${MGMT_IP}" || {
    echo "failed to start lldpd" >&2
    exit 1
  }
  configure_lldpd || true
  exec tail -f /dev/null
fi

snmpd -f -Lo -C -c /etc/snmp/snmpd.conf &
SNMPD_PID=$!

wait_for_path /var/agentx/master

start_lldpd 1 "${MGMT_IP}" || {
  echo "failed to start lldpd" >&2
  exit 1
}

configure_lldpd || true

wait "${SNMPD_PID}"
