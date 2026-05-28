#!/usr/bin/env bash
set -euo pipefail

BLUE='\033[0;34m'
GREEN='\033[0;32m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORTS_FILE="${SCRIPT_DIR}/mcp-bridge-ports.json"
MODEL_PATH="${MODEL_PATH:-/Users/robertlee/Workspace/Personal/localclaw/model/gemma-4-E4B-it-Q5_K_M.gguf}"
LLAMA_SERVER="${LLAMA_SERVER:-/Users/robertlee/llama.cpp/build/bin/llama-server}"
PID_FILE="${ROOT_DIR}/.run/llama-server.pid"
LOG_FILE="/tmp/llamacpp-server.log"

echo -e "${BLUE}Restarting llama.cpp Web UI with MCP proxy...${NC}"

if [[ -f "${PID_FILE}" ]]; then
  old_pid="$(cat "${PID_FILE}")"
  if kill -0 "${old_pid}" 2>/dev/null; then
    kill "${old_pid}" || true
    sleep 2
  fi
  rm -f "${PID_FILE}"
fi

pkill -f "llama-server.*--port 8080" 2>/dev/null || true
sleep 1

nohup "${LLAMA_SERVER}" \
  --model "${MODEL_PATH}" \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 70000 \
  --n-gpu-layers 999 \
  --threads 10 \
  --batch-size 512 \
  --ubatch-size 512 \
  --flash-attn auto \
  --webui-mcp-proxy \
  > "${LOG_FILE}" 2>&1 &

echo "$!" > "${PID_FILE}"

for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo -e "${GREEN}llama.cpp ready at http://127.0.0.1:8080 (MCP proxy enabled)${NC}"
    exit 0
  fi
  sleep 1
done

echo "llama.cpp failed to start. See ${LOG_FILE}"
tail -20 "${LOG_FILE}" || true
exit 1
