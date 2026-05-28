#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PID_DIR="${ROOT_DIR}/.run/mcp-bridges"

if [[ ! -d "${PID_DIR}" ]]; then
  exit 0
fi

for pid_file in "${PID_DIR}"/*.pid; do
  [[ -f "${pid_file}" ]] || continue
  pid="$(cat "${pid_file}")"
  if kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}" 2>/dev/null || true
  fi
  rm -f "${pid_file}"
done

pkill -f "supergateway.*701[1-5]" 2>/dev/null || true
