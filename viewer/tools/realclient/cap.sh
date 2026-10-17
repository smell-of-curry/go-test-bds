#!/bin/bash
# Capture the real client's game surface (window minus macOS title bar).
# Usage: cap.sh <out.png> [width_pts height_pts]
set -euo pipefail
out="$1"
if [ $# -ge 3 ]; then
  osascript -e "tell application \"System Events\" to tell (first process whose name contains \"mcpelauncher\") to set size of window 1 to {$2, $(($3 + 28))}" >/dev/null
  # The GL surface repaints blank for a moment after a resize.
  sleep 4
fi
raw="${out%.png}.raw.png"
rm -f "$raw"
curl -sf -m 15 "127.0.0.1:47800/capture?app=mcpelauncher&out=$raw" >/dev/null
# The helper answers before the PNG is flushed.
for _ in $(seq 50); do [ -s "$raw" ] && python3 -c "from PIL import Image;Image.open('$raw').load()" 2>/dev/null && break; sleep 0.1; done
python3 - "$raw" "$out" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1])
title = 56 if im.size[0] < 4000 else 84  # 28pt title bar at 2x
im.crop((0, title, im.size[0], im.size[1])).save(sys.argv[2])
print(sys.argv[2], im.size[0], im.size[1] - title)
PY
rm -f "$raw"
