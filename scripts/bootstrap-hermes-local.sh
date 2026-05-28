#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"

echo "== 1) MCP bridges =="
./scripts/start-mcp-bridges.sh

echo ""
echo "== 2) llama.cpp Web UI restart (MCP proxy) =="
./scripts/restart-llama-webui.sh

echo ""
echo "== 3) Chrome CDP (tab automation) =="
if ! curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port=9222 \
    --user-data-dir="/tmp/chrome-cdp-profile" \
    about:blank >/tmp/chrome-cdp.log 2>&1 &
  for _ in $(seq 1 20); do
    curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break
    sleep 1
  done
fi
if curl -sf http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "Chrome CDP ready on :9222"
else
  echo "WARN: Chrome CDP not ready. Tab automation may fail until Chrome restarts with debug port."
fi

echo ""
echo "== 4) Register MCP in Web UI =="
node scripts/setup-webui-mcp.mjs --apply

echo ""
echo "== 5) macOS permissions panels =="
./scripts/open-macos-permissions.sh

echo ""
echo "== 6) Scenario tests =="
node scripts/test-mcp-scenarios.mjs

echo ""
echo "== 7) Config validation =="
node scripts/check-hermes-local.mjs

echo ""
echo "Done. Open http://127.0.0.1:8080 → MCP Servers to confirm 5 servers connected."
