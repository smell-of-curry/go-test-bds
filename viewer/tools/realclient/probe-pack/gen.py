#!/usr/bin/env python3
"""Generate probe-pack textures. No Mojang assets.

Run from anywhere:

    python3 viewer/tools/realclient/probe-pack/gen.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent / "textures" / "probe"


def save(img: Image.Image, name: str) -> None:
    path = OUT / name
    img.save(path, format="PNG")
    print(f"wrote {path} {img.size[0]}x{img.size[1]}")


def solid(w: int, h: int, rgba: tuple[int, int, int, int]) -> Image.Image:
    img = Image.new("RGBA", (w, h), rgba)
    return img


def checker() -> Image.Image:
    """16x32, 4px cells, saturated pair, 1px red border."""
    w, h, cell = 16, 32, 4
    a = (0, 220, 255, 255)
    b = (255, 0, 200, 255)
    img = Image.new("RGBA", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            on = ((x // cell) + (y // cell)) % 2 == 0
            px[x, y] = a if on else b
    red = (255, 0, 0, 255)
    for x in range(w):
        px[x, 0] = red
        px[x, h - 1] = red
    for y in range(h):
        px[0, y] = red
        px[w - 1, y] = red
    return img


def gradient() -> Image.Image:
    """16x16 hue across x, lightness down y (tint-multiply target)."""
    img = Image.new("RGBA", (16, 16))
    px = img.load()
    for y in range(16):
        light = 1.0 - (y / 15.0) * 0.65
        for x in range(16):
            hue = x / 15.0
            r, g, b = hsv_to_rgb(hue, 1.0, light)
            px[x, y] = (r, g, b, 255)
    return img


def hsv_to_rgb(h: float, s: float, v: float) -> tuple[int, int, int]:
    i = int(h * 6.0)
    f = h * 6.0 - i
    p = v * (1.0 - s)
    q = v * (1.0 - f * s)
    t = v * (1.0 - (1.0 - f) * s)
    i = i % 6
    if i == 0:
        r, g, b = v, t, p
    elif i == 1:
        r, g, b = q, v, p
    elif i == 2:
        r, g, b = p, v, t
    elif i == 3:
        r, g, b = p, q, v
    elif i == 4:
        r, g, b = t, p, v
    else:
        r, g, b = v, p, q
    return (round(r * 255), round(g * 255), round(b * 255))


def nine() -> Image.Image:
    """12x12, 3px border. Distinct corners, dark edges, light center."""
    img = Image.new("RGBA", (12, 12), (210, 210, 210, 255))
    px = img.load()
    dark = (20, 20, 28, 255)
    corners = {
        (0, 0): (220, 30, 30, 255),
        (1, 0): (30, 180, 50, 255),
        (0, 1): (30, 70, 220, 255),
        (1, 1): (230, 200, 20, 255),
    }
    for y in range(12):
        for x in range(12):
            edge = x < 3 or x >= 9 or y < 3 or y >= 9
            if edge:
                px[x, y] = dark
            cx = 0 if x < 3 else (1 if x >= 9 else -1)
            cy = 0 if y < 3 else (1 if y >= 9 else -1)
            if cx >= 0 and cy >= 0:
                px[x, y] = corners[(cx, cy)]
    return img


def ring() -> Image.Image:
    """16x16 magenta ring. Center is fully transparent."""
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    px = img.load()
    cx = cy = 7.5
    for y in range(16):
        for x in range(16):
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            if 3.2 <= d <= 7.6:
                px[x, y] = (255, 0, 200, 255)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    save(solid(8, 8, (255, 255, 255, 255)), "solid.png")
    save(checker(), "checker16x32.png")
    save(gradient(), "grad.png")
    save(nine(), "nine.png")
    save(solid(8, 8, (0, 0, 0, 255)), "black.png")
    save(ring(), "ring.png")


if __name__ == "__main__":
    main()
