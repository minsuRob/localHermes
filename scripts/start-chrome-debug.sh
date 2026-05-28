#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

CHROME_DEBUG_PORT="${CHROME_DEBUG_PORT:-9222}"
CHROME_DEBUG_URL="http://127.0.0.1:${CHROME_DEBUG_PORT}"
CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-/tmp/chrome-cdp-profile}"
PID_FILE="${ROOT_DIR}/chrome-debug.pid"
LOG_FILE="/tmp/chrome-debug.log"

log_info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

cdp_ready() {
  curl -sf "${CHROME_DEBUG_URL}/json/version" &>/dev/null
}

echo ""
echo -e "${BLUE}=================================================${NC}"
echo -e "${BLUE}  Chrome CDP 디버그 모드 시작                     ${NC}"
echo -e "${BLUE}=================================================${NC}"
echo ""

if cdp_ready; then
  log_success "Chrome CDP가 이미 응답 중입니다: ${CHROME_DEBUG_URL}"
  VERSION="$(curl -sf "${CHROME_DEBUG_URL}/json/version" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Browser","unknown"))' 2>/dev/null || echo "unknown")"
  log_info "Browser: ${VERSION}"
  exit 0
fi

if [[ -f "${PID_FILE}" ]]; then
  EXISTING_PID="$(cat "${PID_FILE}")"
  if kill -0 "${EXISTING_PID}" 2>/dev/null; then
    log_warn "Chrome 프로세스가 실행 중이지만 CDP가 아직 준비되지 않았습니다 (PID: ${EXISTING_PID})"
  else
    rm -f "${PID_FILE}"
  fi
fi

if [[ ! -d "/Applications/Google Chrome.app" ]]; then
  log_error "Google Chrome.app을 찾을 수 없습니다."
  exit 1
fi

log_info "Chrome을 remote debugging port ${CHROME_DEBUG_PORT}로 실행합니다..."
log_info "profile: ${CHROME_USER_DATA_DIR}"
log_info "로그: ${LOG_FILE}"

"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port="${CHROME_DEBUG_PORT}" \
  --user-data-dir="${CHROME_USER_DATA_DIR}" \
  about:blank >> "${LOG_FILE}" 2>&1 &

MAX_RETRIES=20
RETRY=0
while [[ ${RETRY} -lt ${MAX_RETRIES} ]]; do
  if cdp_ready; then
    CHROME_PID="$(pgrep -x "Google Chrome" | head -1 || true)"
    if [[ -n "${CHROME_PID}" ]]; then
      echo "${CHROME_PID}" > "${PID_FILE}"
    fi
    echo ""
    log_success "Chrome CDP 준비 완료!"
    echo ""
    echo -e "  ${GREEN}CDP URL:${NC}  ${CHROME_DEBUG_URL}"
    echo -e "  ${GREEN}PID:${NC}     ${CHROME_PID:-(unknown)}"
    echo -e "  ${GREEN}로그:${NC}    ${LOG_FILE}"
    echo ""
    echo -e "chrome-devtools MCP가 이 포트에 연결됩니다."
    echo ""
    exit 0
  fi

  RETRY=$((RETRY + 1))
  printf "."
  sleep 1
done

echo ""
log_error "20초 내에 Chrome CDP가 응답하지 않습니다."
log_error "Chrome이 이미 실행 중이면 종료 후 다시 시도하거나, 별도 프로필로 실행하세요."
log_error "로그 확인: cat ${LOG_FILE}"
exit 1
