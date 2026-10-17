#!/bin/bash
# Reload resource packs in the real client: leave the world and re-enter the
# most recently played local world (first local tile). Keyboard-only, so it
# works while the window is on another Space.
# Usage: reload.sh [--from-menu]
set -euo pipefail
H=127.0.0.1:47800
send() { curl -sf -m 30 -X POST "$H/input" -d "{\"app\":\"mcpelauncher\",\"actions\":$1}" >/dev/null; }
k() { printf '{"type":"key","key":"%s"},{"type":"wait","ms":%s}' "$1" "${2:-350}"; }

if [ "${1:-}" != "--from-menu" ]; then
  # The first Escape after focus changes is sometimes swallowed; a second one
  # on the pause screen would resume, so pause, then check nothing else.
  send "[$(k escape 2500),$(k down),$(k down),$(k down),$(k enter 9000)]"
fi
# World list, nothing focused: two downs reach the tile row, right skips the
# realm/friend tile to the first local world.
send "[$(k down),$(k down),$(k right),$(k enter 3000),$(k down),$(k enter 25000)]"
