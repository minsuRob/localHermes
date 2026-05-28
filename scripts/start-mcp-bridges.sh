#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORTS_FILE="${SCRIPT_DIR}/mcp-bridge-ports.json"
PID_DIR="${ROOT_DIR}/.run/mcp-bridges"
LOG_DIR="/tmp/localhermes-mcp-bridges"

cd "${ROOT_DIR}"

log_info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

mkdir -p "${PID_DIR}" "${LOG_DIR}"

if [[ ! -f "${PORTS_FILE}" ]]; then
  log_error "Missing ${PORTS_FILE}"
  exit 1
fi

start_bridge() {
  local name="$1"
  local port="$2"
  local stdio_cmd="$3"
  local pid_file="${PID_DIR}/${name}.pid"
  local log_file="${LOG_DIR}/${name}.log"

  if [[ -f "${pid_file}" ]] && kill -0 "$(cat "${pid_file}")" 2>/dev/null; then
    if curl -sf "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      log_success "${name} already running on :${port}"
      return 0
    fi
  fi

  log_info "Starting ${name} bridge on :${port}"
  nohup npx -y supergateway \
    --stdio "${stdio_cmd}" \
    --port "${port}" \
    --outputTransport streamableHttp \
    --cors \
    --healthEndpoint /healthz \
    > "${log_file}" 2>&1 &

  echo "$!" > "${pid_file}"

  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      log_success "${name} ready at http://127.0.0.1:${port}/mcp"
      return 0
    fi
    if ! kill -0 "$(cat "${pid_file}")" 2>/dev/null; then
      log_error "${name} exited early. See ${log_file}"
      tail -20 "${log_file}" || true
      return 1
    fi
    sleep 1
  done

  log_error "${name} health check timed out. See ${log_file}"
  return 1
}

echo ""
echo -e "${BLUE}=================================================${NC}"
echo -e "${BLUE}  MCP stdio → HTTP bridges (supergateway)         ${NC}"
echo -e "${BLUE}=================================================${NC}"
echo ""

while IFS= read -r name; do
  port="$(python3 -c "import json; print(json.load(open('${PORTS_FILE}'))['${name}']['port'])")"
  stdio="$(python3 -c "import json; print(json.load(open('${PORTS_FILE}'))['${name}']['stdio'])")"
  start_bridge "${name}" "${port}" "${stdio}"
done < <(python3 -c "import json; print('\n'.join(json.load(open('${PORTS_FILE}')).keys()))")

echo ""
log_success "All MCP bridges started"
echo ""
