# JSON UI — findings from the real client

These historical observations were recovered from the October 17 stash. They
record comparisons against Bedrock 1.26.51 through mcpelauncher on macOS; they
are not a fresh certification of complete renderer parity. The experimental
probe pack and machine-specific capture tools are preserved in
[the recovery branch](https://github.com/smell-of-curry/go-test-bds/tree/recovery/desktop-stash-2026-10-17/viewer/tools/realclient).

The November integration adds automated coverage for layout, image painting,
font rasterization, and fallback text shadows. The open questions below still
need controlled real-client comparisons.

## GUI scale

The client picks an integer scale from the framebuffer height, then applies the
user's `gfx_guiscale_offset` (options.txt). With offset `-4` (the minimum) the
observed scale is `H/360 - 1`: 1 at 720 px, 2 at 1080 px, 3 at 1440 px. A
comparison is only meaningful at the same framebuffer size **and** scale; the
screen in UI units is `W/scale × H/scale` (960×540 at 1920×1080, scale 2), not
a fixed 640×360.

## Text

**November correction:** the historical TTF calibration below reproduced a
heavier outline fallback, not the native default bitmap font. Installed-client
`font/default8.png` has one-pixel regular ASCII strokes. The renderer now uses
that atlas (pack overrides first), including the 1.26.60 metadata's 12-pixel row
pitch and −3 vertical offset; explicit `§l` adds the bold stroke separately.
The old outline mask is retained only as a fallback test. Matched current-client
captures are still required for extended Unicode, smooth-font labels, and
complete pixel parity.

- Font: `assets/fonts/Mojangles.ttf` from the client install (not in
  bedrock-samples; never vendored). 100 font units = 1 design pixel, cap 7,
  cell 8. Glyphs are fully crisp: exactly text + shadow colours.
- Shadow: offset one UI unit right and down, opaque, colour = text colour ×
  0.25 per channel (white → 64,64,64; §c 255,84,84 → 64,21,21).
- A single-line label wider than its box is truncated with `...`; it neither
  wraps nor shrinks.

## Images

- `keep_ratio` defaults to **true** for non-nineslice images: the texture is
  aspect-fitted and centred in the element box. Only `keep_ratio: false`
  stretches. (Probe cells A, D, L; an 8×8 `black.png` sized 100%×100% on a
  1920×1080 screen paints a centred 1080×1080 square.)
- Nineslice images stretch their centre regardless.
- `color` multiplies the texture (a hue gradient tinted `[1,0,0]` stays a
  gradient); it does not replace RGB.
- `uv` / `uv_size` crop as expected.

## Layout

- `offset` percentages without a suffix are of the **parent** size; `%x` is of
  the element's own width.
- A panel with no `size` fills its parent (children anchored `bottom_right` sit
  in the parent's corner whether the panel is anchored `top_left` or `center`).
- Children are not clamped into their parent; they overflow freely and are only
  cut by `clips_children` or the screen edge.

## Paint order

- Layers are absolute: an element's effective layer is the sum of its own and
  all ancestors' `layer` values, and ordering is across the whole screen, not
  per parent. A child at `5 + (-10) = -5` paints behind a root image at layer 0.
- When a parent image and its child resolve to the same effective layer, the
  **parent paints over the child**: a white `alpha: 0.5` plate over an opaque
  red child reads `255,128,128`.
- `clips_children: true` changes the order between siblings (probe cell K:
  the later sibling is in front with clipping on and behind with it off).
  Unresolved — needs an isolating probe.

## Open

- Exact tie-break between same-layer siblings (declaration order observed for
  three plain images; cell K contradicts it when clipping is off).
- `font_scale_factor` and `font_size` rendering (probe cell I).
- `propagate_alpha`.

## Current-client comparison protocol

Use the same 1.26.60.4 client assets and pack versions on both sides, English,
classic UI, a 1280×720 framebuffer, and GUI scale 2. Record safe-zone and font
settings. Keep the native PNG at original size; do not resize a video frame to
make it align. Save the shadow-recorded packet/tick with each native screenshot.

Capture an ordinary form with a plain label, explicit `§l` label, accented
text, and the Back icon in default/hover states. Capture a battle move form
with enabled and disabled Bag/Party/Run actions, then the party switch and
result forms. Capture the same HUD with no form and with a form open so menu
visibility is observed instead of inferred. For isolated pixel comparisons,
use an identical solid background; translucent UI over different world frames
cannot be judged by raw RGB equality.

Compare glyph ink/spacing/baselines, sliced-image boundaries, action-tab count,
control bounds, and visible HUD separately. Preserve native/viewer PNGs and
pixel-difference images with source hashes. The ordinary ASCII atlas and nested
rawtext decoder fixes have direct source evidence; sliced-arrow dimensions and
HUD visibility still need this matched native check. OreUI uses a separate
runtime and is not covered by the JSON UI renderer.
