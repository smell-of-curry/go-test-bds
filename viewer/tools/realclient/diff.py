#!/usr/bin/env python3
"""Pixel-diff two probe screenshots.

    python3 diff.py real.png viewer.png out.png [--gui-scale 2] [--probe probe.json]
        [--mask x,y,w,h ...]

Images must match in size. `out.png` is real | viewer | abs-diff amplified ×8.
Stats skip pixels the viewer cannot reproduce: the launcher ImGui menubar
(top 22 px at 1080p, scaled by height/1080) and the top-right FPS/MEM overlay
(right 240 × top 110 px at 1080p, scaled the same way). Extra `--mask`
rectangles are image pixels. `cell_*` rects, including M1–M9, come from probe.json.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

AMP = 8


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("real")
    p.add_argument("viewer")
    p.add_argument("out")
    p.add_argument("--gui-scale", type=float, default=2.0)
    p.add_argument(
        "--probe",
        default=str(Path(__file__).resolve().parent / "probe-pack" / "ui" / "probe.json"),
    )
    p.add_argument(
        "--mask",
        action="append",
        default=[],
        metavar="x,y,w,h",
        help="extra image-pixel rectangle to exclude (repeatable)",
    )
    return p.parse_args()


def parse_mask(raw: str) -> tuple[int, int, int, int]:
    parts = [s.strip() for s in raw.split(",")]
    if len(parts) != 4:
        raise SystemExit(f"--mask wants x,y,w,h, got {raw!r}")
    try:
        x, y, w, h = (int(p) for p in parts)
    except ValueError as err:
        raise SystemExit(f"--mask wants integers, got {raw!r}") from err
    if w <= 0 or h <= 0:
        raise SystemExit(f"--mask width and height must be positive, got {raw!r}")
    return x, y, w, h


def default_masks(width: int, height: int) -> list[tuple[str, int, int, int, int]]:
    """Launcher chrome scaled from a 1080p reference by height/1080."""
    scale = height / 1080
    bar_h = max(1, round(22 * scale))
    ov_w = max(1, round(240 * scale))
    ov_h = max(1, round(110 * scale))
    return [
        ("menubar", 0, 0, width, bar_h),
        ("fps_mem", max(0, width - ov_w), 0, ov_w, ov_h),
    ]


def cells(path: Path) -> list[tuple[str, int, int, int, int]]:
    doc = json.loads(path.read_text())
    out: list[tuple[str, int, int, int, int]] = []
    for key, value in doc.items():
        if not key.startswith("cell_") or not isinstance(value, dict):
            continue
        off = value.get("offset")
        size = value.get("size")
        if (
            not isinstance(off, list)
            or not isinstance(size, list)
            or len(off) < 2
            or len(size) < 2
        ):
            continue
        if not all(
            isinstance(n, (int, float)) and not isinstance(n, bool)
            for n in (*off[:2], *size[:2])
        ):
            continue
        out.append((key, int(off[0]), int(off[1]), int(size[0]), int(size[1])))
    out.sort(key=lambda row: row[0])
    if not out:
        raise SystemExit(f"no numeric cell_* rects in {path}")
    return out


def mask_image(
    size: tuple[int, int], rects: list[tuple[int, int, int, int]]
) -> Image.Image:
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    w, h = size
    for x, y, rw, rh in rects:
        x0 = max(0, x)
        y0 = max(0, y)
        x1 = min(w, x + rw)
        y1 = min(h, y + rh)
        if x1 > x0 and y1 > y0:
            draw.rectangle((x0, y0, x1 - 1, y1 - 1), fill=255)
    return mask


def mean_abs_masked(
    diff: Image.Image, mask: Image.Image, box: tuple[int, int, int, int]
) -> tuple[float, int, int]:
    """Mean abs RGB over unmasked pixels in box. Returns (mean, used, skipped)."""
    d = diff.crop(box).convert("RGB")
    m = mask.crop(box)
    db = d.tobytes()
    mb = m.tobytes()
    total = 0
    used = 0
    skipped = 0
    n = d.size[0] * d.size[1]
    for i in range(n):
        if mb[i]:
            skipped += 1
            continue
        o = i * 3
        total += db[o] + db[o + 1] + db[o + 2]
        used += 1
    if used <= 0:
        return float("nan"), 0, skipped
    return total / (used * 3), used, skipped


def main() -> None:
    args = parse_args()
    real = Image.open(args.real)
    viewer = Image.open(args.viewer)
    if real.size != viewer.size:
        print(
            f"size mismatch real={real.size[0]}x{real.size[1]} viewer={viewer.size[0]}x{viewer.size[1]}",
            file=sys.stderr,
        )
        raise SystemExit(2)

    w, h = real.size
    rgb_a = real.convert("RGB")
    rgb_b = viewer.convert("RGB")
    diff = ImageChops.difference(rgb_a, rgb_b)
    amp = diff.point(lambda v: min(255, v * AMP))

    named = default_masks(w, h)
    rects: list[tuple[int, int, int, int]] = []
    for name, x, y, rw, rh in named:
        rects.append((x, y, rw, rh))
        print(f"mask {name} {x},{y},{rw},{rh}")
    for raw in args.mask:
        x, y, rw, rh = parse_mask(raw)
        rects.append((x, y, rw, rh))
        print(f"mask extra {x},{y},{rw},{rh}")
    mask = mask_image((w, h), rects)

    # Grey the masked region on the diff panel so chrome does not dominate it.
    amp_rgb = amp.convert("RGB")
    grey = Image.new("RGB", (w, h), (32, 32, 32))
    amp_rgb.paste(grey, mask=mask)

    canvas = Image.new("RGB", (w * 3, h), (0, 0, 0))
    canvas.paste(rgb_a, (0, 0))
    canvas.paste(rgb_b, (w, 0))
    canvas.paste(amp_rgb, (w * 2, 0))
    canvas.save(args.out)
    print(f"wrote {args.out} {canvas.size[0]}x{canvas.size[1]}")

    scale = args.gui_scale
    overall, used, skipped = mean_abs_masked(diff, mask, (0, 0, w, h))
    print(
        f"masked overall mean_abs={overall:.3f} used_px={used} masked_px={skipped}"
    )
    for name, x, y, cw, ch in cells(Path(args.probe)):
        x0 = int(round(x * scale))
        y0 = int(round(y * scale))
        x1 = int(round((x + cw) * scale))
        y1 = int(round((y + ch) * scale))
        x0 = max(0, min(w, x0))
        x1 = max(0, min(w, x1))
        y0 = max(0, min(h, y0))
        y1 = max(0, min(h, y1))
        if x1 <= x0 or y1 <= y0:
            print(f"{name} mean_abs=nan empty_rect")
            continue
        mean, cell_used, cell_skip = mean_abs_masked(diff, mask, (x0, y0, x1, y1))
        if cell_used <= 0:
            print(f"{name} mean_abs=nan fully_masked")
            continue
        extra = f" masked_px={cell_skip}" if cell_skip else ""
        print(f"{name} mean_abs={mean:.3f}{extra}")


if __name__ == "__main__":
    main()
