#!/usr/bin/env bash
set -euo pipefail

echo "Opening macOS Privacy settings. Grant permissions to Terminal/Cursor/Node as prompted."
echo ""

open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation" || true
sleep 1
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" || true
sleep 1
open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" || true
sleep 1
open "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders" || true

echo ""
echo "Enable for processes that spawn MCP:"
echo "  - Terminal (or Cursor)"
echo "  - node / npx"
echo "  - Google Chrome (for chrome-devtools)"
echo ""
