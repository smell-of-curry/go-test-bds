# JSON UI probe pack

Resource pack that draws the same controls in a real Bedrock client and in the viewer JSON UI engine. `root` is a full-screen panel. First child is an opaque `textures/probe/black` image at 100%×100% with `keep_ratio: false` so it stretches over the whole screen. Bedrock's default `keep_ratio` is true, which aspect-fits an 8×8 texture into a centred square and lets the world show in the side bars.

Every later child is a cell panel anchored `top_left` with a numeric `offset` and `size`. Cells A–L stay at the original positions inside 480×270 gui px. Cell M is nine sub-cells (`cell_m1`…`cell_m9`) in the free right half of a 960×540 screen (1920×1080 at GUI scale 2), each with `x >= 490`. `diff.py` reads every `cell_*` `offset` and `size`, including the M sub-cells.

Vanilla `hud_screen.json` `root_panel` is a `panel` whose children live in `controls` (real 1.26.51 UI, unpacked from `vanilla/__brarchive/ui.brarchive`). This pack does not replace that screen. `ui/hud_screen.json` `insert_back`s `probe_root@probe.root` with `layer` 1000.

All textures come from `gen.py` (`python3 gen.py`). No Mojang pixels.

Layout for A–L stays inside 480×270 gui px so old captures stay comparable. M uses the right half of the 960×540 scale-2 screen. Exact 60×60 / 80×40 / 30×60 specimens do not tile into a uniform 110×80 grid.

| Cell | Rect (x, y, w, h) |
| --- | --- |
| A | 4, 4, 188×44 |
| E | 196, 4, 180×46 |
| H | 380, 4, 96×72 |
| B | 4, 52, 188×74 |
| C | 196, 52, 128×74 |
| G | 328, 52, 48×46 |
| D | 4, 130, 188×92 |
| F | 196, 130, 128×72 |
| J | 328, 104, 148×52 |
| K | 328, 160, 148×62 |
| L | 4, 224, 120×44 |
| I | 128, 224, 348×44 |
| M1 | 496, 4, 40×42 |
| M2 | 540, 4, 40×42 |
| M3 | 584, 4, 40×42 |
| M4 | 628, 4, 40×42 |
| M5 | 672, 4, 40×42 |
| M6 | 716, 4, 40×42 |
| M9 | 760, 4, 40×42 |
| M7 | 496, 52, 70×72 |
| M8 | 572, 52, 70×72 |

## What each cell distinguishes

**A keep_ratio.** Three `checker16x32` images (texture 1:2) in identical 60×30 boxes (box 2:1), left to right: `keep_ratio` false, true, omitted. Stretch-to-box fills 60×30 with a distorted checker and the red border runs the whole edge. Preserve-aspect letterboxes or pillarboxes, leaving empty bars and a uniform (not stretched) checker. Omitted matching false means the default is stretch; matching true means the default preserves aspect.

**B offset percent base.** Three 60×60 grey plates (`solid` tinted `[0.3,0.3,0.3]`), each with a 10×10 red child anchored `top_left`. Offsets left to right: `["50%", 0]`, `["50%x", 0]`, `["50%c", 0]`. A parent-size `%` puts the child near x=30. `%x` of the child's own width puts it near x=5. `%c` of children is the child's own size, also near x=5, or 0 if children are not a legal offset base. The three x positions separate those bases. (If `%x` / `%c` are ignored, that plate matches the `%` plate or sits at 0.)

**C omitted size.** Two 60×60 grey parents. Each holds a panel with **no** `size` whose only child is a 10×10 green image anchored `bottom_right` both ways. Left host keeps default anchors. Right host sets the sizeless panel to `center`/`center`. If omitted size is 100% of the parent, both greens sit in the grey corner and the center anchor changes nothing (the panel fills the parent). If omitted size hugs the child, the green's box is ~10×10: left sits wherever the default anchor puts a small box (viewer default is center), right sits at the parent's center. A 0×0 panel hides the green.

**D size units.** Grey 80×40 parents, top-left to bottom-right:

- image `["50%", "100%"]` — half the parent width, full height (~40×40) if `%` is the parent axis
- image `["50%y", "100%"]` — width is half of *this* height. Height is 100% of the parent, so self-height and parent-height agree (~20 wide). A width other than ~20 means `%y` is not "this height"
- green `["100%c", 16]` with a 24×10 red child — ~24 wide if `%c` is child extent; ~80 if it falls through to parent; 0 if children are ignored
- horizontal `stack_panel` `[80, 12]`: 20-wide red sibling plus `["fill", 10]` green. Fill should take the leftover ~60. A full-width green means `fill` was read as `100%`
- yellow `["50% + 5px", 8]` in an 80-wide parent → ~45. Blue `["100% - 10px", 8]` → ~70. A raw 50 or 100 means the `px` term was dropped

**E tint.** `grad.png` at 32×32: untinted, `color [1,0,0]`, `color [0.5,0.5,1.0]`, `alpha` 0.5, then a white `solid` tinted `[0.25, 0.6, 1.0]`. Multiply tint turns the red swatch into a red ramp (green/blue channels gone) and the white solid into that blue. Alpha 0.5 shows the black backdrop through the gradient. Identical swatches mean `color` is ignored or treated as a vertex replace of a missing texture.

**F nineslice.** `nine.png` plus `nine.json` (`nineslice_size` 3, `base_size` [12, 12]). Element `nineslice_size` is omitted on the 12×12, 48×24, and 30×60 images so the texture json supplies 3. Corners stay 3 source px (distinct colors) and the light center stretches. The 24×24 sets element `nineslice_size` 1, which must beat the json: corners become 1 px and more of the dark edge stretches. All four looking like a uniform stretch means nineslice was skipped. The 1-slice matching the 3-slice means element size lost to the json.

**G uv.** `checker16x32` with `uv [0,0]` `uv_size [8,8]` in a 16×16 box (top-left quarter, no red bottom border) and `uv [8,16]` `uv_size [8,16]` in a 16×32 box (lower-right half, includes the bottom/right red border). A full-image stretch means `uv` was ignored.

**H layers.** Two trios of overlapping 20×20 solids (red, green, blue) offset by 6. First trio `layer` 0,0,0 — declaration order decides ties (later on top if the engine paints in order). Second trio layers 2, 1, 0 — red should cover green should cover blue regardless of order. Then a parent `layer` 5 with a child `layer` -10 overlapping a sibling `layer` 1. If layer is global, the sibling (1) paints over the child (-10). If the parent is a stacking context, the child stays above the sibling because the parent is 5.

**I labels.** Sentence `The quick brown fox 0123456789` unless noted. Boxes are fixed so a too-wide line clips instead of shoving the next cell.

- default (shadow omitted)
- `shadow` true — dark offset pixels; matching default means shadow is ignored (the engine root also paints a CSS shadow even when `shadow` is false)
- `color [1, 0.33, 0.33]`
- `font_scale_factor` 2 — glyphs about twice the default line
- `font_size` `large` (~1.25) and `small` (~0.75) against the default line
- `text_alignment` `center` and `right` inside a 120-wide box — the sentence is wider than 120, so the visible window shifts to the middle or the end
- `max_width` 60 (no fixed width story beyond `size` height) versus a sibling whose **size** width is 60. If only the fixed box wraps onto multiple lines, `max_width` is not a layout constraint here
- `§aGreen §lBold§r §oItalic` — green run, bold, reset, italic. Literal `§` left on screen means codes are not parsed

**J alpha propagation.** White parent image `alpha` 0.5 with a fully opaque red child, versus the same with `propagate_alpha` true. Child stays solid red when alpha does not propagate. Both wash out equally when the parent opacity multiplies descendants. Matching pairs mean `propagate_alpha` is ignored.

**K clips_children.** 30×30 panel, grey frame, 50×50 checker child at `[-10, -10]`. Left `clips_children` true: checker cropped to the grey frame. Right false: checker spills ~10 px up/left and ~20 px down/right. Both spilling means the flag is ignored; both cropped means the engine always clips.

**L stack_panel.** Vertical and horizontal stacks of 10×10, 15×10, 20×10 solids (red, green, blue) sized `100%c`. Main axis should sum (vertical height 30, horizontal width 45) with no gaps. A third horizontal stack is 40 wide with one child `size ["100%c", 10]` wrapping a 16×8 chip. The chip's row should be ~16 wide if `%c` is content, or 40 if the stack forces the child to the stack's width.

**M paint order.** Red is `[1,0,0]`, blue is `[0,0.35,1]`. M1–M6 use two 20×20 solids overlapping on the right half of the first square (overlap is a 10×20 strip; its centre is the sample point). `keep_ratio` is false on these squares. Hypothesis P: opaque controls paint first and any control with `alpha < 1` paints in a later pass, so a translucent control ends up on top no matter the tree order. Hypothesis T: pure tree order, later declaration on top (a child after its parent's own pixels; a second sibling after the first). Sample the overlap centre.

| Cell | Setup | If P holds | If T holds |
| --- | --- | --- | --- |
| M1 | parent image `alpha` 1.0, child opaque, child overlaps the parent's right half | Both opaque, so no late pass. Child is later → solid blue centre | Solid blue centre |
| M2 | parent `alpha` 0.99, child opaque | Parent is translucent so it paints after the child. Centre is nearly red (0.99 red over blue) | Child is later → solid blue |
| M3 | parent `alpha` 1.0, child `alpha` 0.5 | Child is the translucent one, so it paints on top. Centre is blue at 0.5 over red (pale) | Same: child later → pale blue over red |
| M4 | siblings: first `alpha` 0.5 (red), second opaque (blue), overlapping | First is translucent so it paints on top of the later opaque sibling. Centre is red at 0.5 over blue | Second is later → solid blue |
| M5 | siblings: first opaque (red), second `alpha` 0.5 (blue) | Second is translucent so it paints on top. Centre is blue at 0.5 over red | Same: second later → pale blue over red |
| M6 | parent `alpha` 0.5 `propagate_alpha` true, child authored opaque | Child inherits 0.5, so both are late and tree order among them puts the child on top: washed blue over washed red, and the child's non-overlapped part is also washed (not solid). If `propagate_alpha` is ignored, the child stays opaque (early) and the parent paints on top: centre is red at 0.5 over solid blue, and the child's free half stays solid blue | Child later and still opaque → solid blue centre; the parent's free half is red at 0.5 |

M7 is cell K-off exactly: `clips_children` false, grey 30×30 frame declared first, then a 50×50 `checker16x32` at `[-10,-10]`, except the checker has `keep_ratio: false`. M8 swaps that declaration order (checker first, frame second). Alpha does not differ, so P does not reorder them.

- If T holds (later on top): M7's checker covers the grey frame; M8's grey frame covers the checker.
- If clips-off reverses sibling order (K-off on the real client): M7's frame is in front of the later checker; M8's checker is in front of the later frame.

M9 is two fully overlapping 16×16 siblings: `ring.png` (magenta opaque ring, transparent centre) declared first, then an opaque green solid. The overlap centre is the hole.

- If a texture with transparent pixels counts as translucent and takes the late pass (P): the ring paints on top. Centre is green (the solid showing through the hole); a ring pixel is magenta.
- If T holds (solid later, on top): the solid covers the ring. Centre and ring pixels are both green. No magenta in the overlap.

## Textures

| File | Pixels |
| --- | --- |
| `solid.png` | 8×8 white |
| `checker16x32.png` | 16×32, 4 px cyan/magenta checker, 1 px red border |
| `grad.png` | 16×16 hue × lightness |
| `nine.png` | 12×12, 3 px corners (red/green/blue/yellow), dark edges, light center |
| `nine.json` | nineslice 3, base 12×12 |
| `black.png` | 8×8 black. Background sets `keep_ratio: false` so this stretches to the screen |
| `ring.png` | 16×16 magenta ring, transparent centre |
