/**
 * Bedrock default bitmap font, with an optional Mojangles outline fallback.
 * Native JSON UI text uses font/default8.png; the TTF is visibly heavier.
 * The fallback draws the TTF on a 100-unit grid
 * (unitsPerEm 1000 → 10px em, cap height 7, one descender row → 8px cell).
 * OS rasterizers anti-alias that grid, so labels are filled from the glyf
 * outlines (coverage ≥ 0.5) and scaled with nearest-neighbor by guiScale.
 *
 * Font assets come from the pack stack or the configured /font directory. They
 * are Mojang content and are never vendored in this repo.
 */

/** CSS family registered by {@link ensureMojangles}. */
export const MOJANGLES_FAMILY = "Mojangles";

/** Fallback when the hub has no font file. */
export const MOJANGLES_FALLBACK =
  'ui-sans-serif, system-ui, "Segoe UI", sans-serif';

/** Family plus fallback. Canvas metrics and CSS must use the same string. */
export const MOJANGLES_STACK = `"${MOJANGLES_FAMILY}", ${MOJANGLES_FALLBACK}`;

/** Design pixels in one em (unitsPerEm / 100). Cap sits in the top 7. */
const EM_PX = 10;

/** Glyph cell height in design pixels (cap 7 + one descender row). */
const CELL_PX = 8;

/** Coverage samples per axis. 4×4 makes a half-covered pixel alpha 128. */
const SUB = 4;

const warned = { current: false };
let parsed: MojanglesFont | null = null;
let readyPromise: Promise<boolean> | null = null;

/** One rasterized glyph in design pixels (already fringe-trimmed). */
interface GlyphMask {
  adv: number;
  /** Packed alpha, `CELL_PX * adv` samples, row-major. */
  alpha: Uint8Array;
  /** 0/1 after the right-edge fringe trim. */
  on: Uint8Array;
  /** Last column still has ink, so the next glyph gets a 1px gap. */
  touch: boolean;
}

/** Parsed Mojangles face. Advances are design pixels (1 gui unit). */
export class MojanglesFont {
  private readonly glyphs = new Map<number, GlyphMask>();
  private readonly cmap: (cp: number) => number;
  private readonly outline: (
    gid: number,
  ) => { adv: number; contours: number[][] } | null;

  /**
   * @param cmap - Code point → glyph id.
   * @param outline - Glyph id → advance (design px) and closed contours (x,y pairs).
   */
  constructor(
    cmap: (cp: number) => number,
    outline: (gid: number) => { adv: number; contours: number[][] } | null,
  ) {
    this.cmap = cmap;
    this.outline = outline;
  }

  /**
   * Design-pixel mask for one code point. Missing glyphs advance 0.
   *
   * @param cp - Unicode code point.
   * @returns cached mask.
   */
  glyph(cp: number): GlyphMask {
    const hit = this.glyphs.get(cp);
    if (hit) return hit;
    const built = this.build(cp);
    this.glyphs.set(cp, built);
    return built;
  }

  /** Install a resource-pack bitmap glyph ahead of the outline fallback. */
  setGlyph(cp: number, glyph: GlyphMask): void {
    this.glyphs.set(cp, glyph);
  }

  /**
   * @param cp - Unicode code point.
   * @returns freshly rasterized mask.
   */
  private build(cp: number): GlyphMask {
    const gid = this.cmap(cp);
    const raw = gid === 0 ? null : this.outline(gid);
    const adv = raw?.adv ?? 0;
    const alpha = new Uint8Array(CELL_PX * Math.max(adv, 0));
    const on = new Uint8Array(alpha.length);
    if (raw && adv > 0 && raw.contours.length > 0) {
      for (let j = 0; j < CELL_PX; j++) {
        for (let i = 0; i < adv; i++) {
          let hit = 0;
          for (let sy = 0; sy < SUB; sy++) {
            for (let sx = 0; sx < SUB; sx++) {
              const fx = (i + (sx + 0.5) / SUB) * 100;
              const fy = 700 - (j + (sy + 0.5) / SUB) * 100;
              if (evenOdd(raw.contours, fx, fy)) hit++;
            }
          }
          const a = Math.round((hit / (SUB * SUB)) * 255);
          const at = j * adv + i;
          alpha[at] = a;
          if (a >= 128) on[at] = 1;
        }
      }
      trimRightFringe(on, alpha, adv);
    }
    let touch = false;
    if (adv > 0) {
      for (let j = 0; j < CELL_PX; j++) {
        if (on[j * adv + adv - 1]) touch = true;
      }
    }
    return { adv, alpha, on, touch };
  }
}

/**
 * Install the native default8 ASCII atlas. JSON UI's default font uses these
 * bitmap strokes; Mojangles.ttf is a distinct, heavier outline face. A pack
 * may replace the atlas at any integer multiple of its 128×128 design size.
 * Recent clients specify a taller row pitch and vertical offset in JSON.
 * Non-ASCII characters retain the outline/custom Unicode-page fallback.
 */
export function installDefaultBitmap(
  font: MojanglesFont,
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  metadata: {
    ascii_character_height?: number;
    ascii_character_y_offset?: number;
  } = {},
): void {
  if (
    width !== height ||
    width < 128 ||
    width % 128 !== 0 ||
    rgba.length !== width * height * 4
  ) {
    throw new Error("default8 font must be a square 16×16 atlas of 8px cells");
  }
  const scale = width / 128;
  const rowHeight = metadata.ascii_character_height ?? 8;
  const yOffset = metadata.ascii_character_y_offset ?? 0;
  if (
    !(rowHeight >= 8 && rowHeight <= 16) ||
    !Number.isInteger(rowHeight) ||
    !Number.isInteger(yOffset)
  ) {
    throw new Error("invalid default8 glyph metrics");
  }
  if (
    2 * rowHeight - yOffset < 0 ||
    7 * rowHeight - yOffset + 8 > height / scale
  ) {
    throw new Error("default8 glyph metrics point outside the atlas");
  }
  for (let cp = 32; cp < 127; cp++) {
    const x0 = (cp % 16) * 8 * scale;
    const y0 = (Math.floor(cp / 16) * rowHeight - yOffset) * scale;
    const cell = new Uint8Array(64);
    let last = -1;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const sx = x0 + Math.floor((x + 0.5) * scale);
        const sy = y0 + Math.floor((y + 0.5) * scale);
        const alpha = rgba[(sy * width + sx) * 4 + 3]!;
        if (alpha >= 128) {
          cell[y * 8 + x] = 1;
          last = Math.max(last, x);
        }
      }
    }
    const adv = cp === 32 ? 4 : Math.max(0, last + 1);
    const on = new Uint8Array(adv * CELL_PX);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < adv; x++) on[y * adv + x] = cell[y * 8 + x]!;
    }
    const glyph = { adv, on, alpha: on.map((v) => v * 255), touch: last >= 0 };
    font.setGlyph(cp, glyph);
    if (cp === 32) font.setGlyph(160, glyph);
  }
}

/**
 * Drop a half-covered pixel on the right edge of a 3px run.
 *
 * FreeType coverage turns the right half-pixel of a 2-unit stroke into a
 * third column. Bedrock keeps that column on wide letters (`e`) and drops it
 * when the run is exactly 3 and vertically isolated (`l`, `k`).
 *
 * @param on - Mutated 0/1 mask.
 * @param alpha - Coverage alpha paired with `on`.
 * @param adv - Columns.
 */
function trimRightFringe(on: Uint8Array, alpha: Uint8Array, adv: number): void {
  const x = adv - 1;
  for (let j = 0; j < CELL_PX; j++) {
    const at = j * adv + x;
    if (!on[at]) continue;
    const above = j > 0 ? on[(j - 1) * adv + x] : 0;
    const below = j + 1 < CELL_PX ? on[(j + 1) * adv + x] : 0;
    if (above || below) continue;
    let run = 0;
    for (let i = x; i >= 0 && on[j * adv + i]; i--) run++;
    const left = x > 0 ? alpha[j * adv + x - 1]! : 0;
    if (run === 3 && left >= 250 && alpha[at]! <= 128) on[at] = 0;
  }
}

/**
 * Even-odd point test. Contours are closed implicitly.
 *
 * @param contours - Each contour is a flat `[x,y,...]` list in font units.
 * @param x - Sample x.
 * @param y - Sample y.
 * @returns true when the point is inside.
 */
function evenOdd(contours: number[][], x: number, y: number): boolean {
  let cnt = 0;
  for (const pts of contours) {
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const x1 = pts[i * 2]!;
      const y1 = pts[i * 2 + 1]!;
      const j = (i + 1) % n;
      const x2 = pts[j * 2]!;
      const y2 = pts[j * 2 + 1]!;
      if (y1 === y2) continue;
      if (y1 > y !== y2 > y) {
        const xx = x1 + ((x2 - x1) * (y - y1)) / (y2 - y1);
        if (xx > x) cnt++;
      }
    }
  }
  return cnt % 2 === 1;
}

/**
 * Parse a Mojangles TTF into a rasterizer. Throws on a truncated file.
 *
 * @param buf - TTF bytes.
 * @returns face whose glyphs are design-pixel masks.
 */
export function parseMojangles(buf: ArrayBuffer): MojanglesFont {
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const nTables = view.getUint16(4);
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < nTables; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(
      u8[at]!,
      u8[at + 1]!,
      u8[at + 2]!,
      u8[at + 3]!,
    );
    tables.set(tag, {
      off: view.getUint32(at + 8),
      len: view.getUint32(at + 12),
    });
  }
  const cmap = tables.get("cmap");
  const head = tables.get("head");
  const locaT = tables.get("loca");
  const glyf = tables.get("glyf");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  if (!cmap || !head || !locaT || !glyf || !hhea || !hmtx) {
    throw new Error("mojangles: missing TTF table");
  }
  const indexToLoc = view.getInt16(head.off + 50);
  const numH = view.getUint16(hhea.off + 34);

  const locaOff = (gid: number): number => {
    if (indexToLoc === 0) return view.getUint16(locaT.off + gid * 2) * 2;
    return view.getUint32(locaT.off + gid * 4);
  };
  const advancePx = (gid: number): number => {
    const g = gid < numH ? gid : numH - 1;
    const units = view.getUint16(hmtx.off + g * 4);
    return Math.round(units / 100);
  };

  const mapCp = parseCmap4(view, cmap.off);

  const outline = (
    gid: number,
  ): { adv: number; contours: number[][] } | null => {
    const adv = advancePx(gid);
    const o1 = locaOff(gid);
    const o2 = locaOff(gid + 1);
    if (o1 === o2) return { adv, contours: [] };
    const gp = glyf.off + o1;
    const nCont = view.getInt16(gp);
    if (nCont <= 0) return { adv, contours: [] };
    const ends: number[] = [];
    for (let i = 0; i < nCont; i++) ends.push(view.getUint16(gp + 10 + i * 2));
    const inst = view.getUint16(gp + 10 + nCont * 2);
    let p = gp + 12 + nCont * 2 + inst;
    const nPts = ends[ends.length - 1]! + 1;
    const flags: number[] = [];
    while (flags.length < nPts) {
      const f = u8[p]!;
      p++;
      flags.push(f);
      if (f & 8) {
        const rep = u8[p]!;
        p++;
        for (let r = 0; r < rep; r++) flags.push(f);
      }
    }
    const xs: number[] = [];
    let x = 0;
    for (const f of flags) {
      let dx = 0;
      if (f & 2) {
        dx = u8[p]!;
        p++;
        if ((f & 16) === 0) dx = -dx;
      } else if ((f & 16) === 0) {
        dx = view.getInt16(p);
        p += 2;
      }
      x += dx;
      xs.push(x);
    }
    const ys: number[] = [];
    let y = 0;
    for (const f of flags) {
      let dy = 0;
      if (f & 4) {
        dy = u8[p]!;
        p++;
        if ((f & 32) === 0) dy = -dy;
      } else if ((f & 32) === 0) {
        dy = view.getInt16(p);
        p += 2;
      }
      y += dy;
      ys.push(y);
    }
    const contours: number[][] = [];
    let start = 0;
    for (const end of ends) {
      const flat: number[] = [];
      for (let i = start; i <= end; i++) flat.push(xs[i]!, ys[i]!);
      contours.push(flat);
      start = end + 1;
    }
    return { adv, contours };
  };

  return new MojanglesFont(mapCp, outline);
}

/**
 * Format-4 cmap (Unicode BMP) from the platform-3 subtable.
 *
 * @param view - TTF view.
 * @param cmapOff - Offset of the `cmap` table.
 * @returns code point → glyph id.
 */
function parseCmap4(view: DataView, cmapOff: number): (cp: number) => number {
  const nsub = view.getUint16(cmapOff + 2);
  let sub = 0;
  for (let i = 0; i < nsub; i++) {
    const plat = view.getUint16(cmapOff + 4 + i * 8);
    const off = view.getUint32(cmapOff + 8 + i * 8);
    const fmt = view.getUint16(cmapOff + off);
    if (plat === 3 && fmt === 4) sub = cmapOff + off;
  }
  if (!sub) return () => 0;
  const segCount = view.getUint16(sub + 6) / 2;
  const endOff = sub + 14;
  const startOff = endOff + segCount * 2 + 2;
  const deltaOff = startOff + segCount * 2;
  const rangeOff = deltaOff + segCount * 2;
  const ends: number[] = [];
  const starts: number[] = [];
  const deltas: number[] = [];
  const ranges: number[] = [];
  for (let i = 0; i < segCount; i++) {
    ends.push(view.getUint16(endOff + i * 2));
    starts.push(view.getUint16(startOff + i * 2));
    deltas.push(view.getInt16(deltaOff + i * 2));
    ranges.push(view.getUint16(rangeOff + i * 2));
  }
  return (cp: number): number => {
    for (let i = 0; i < ends.length; i++) {
      if (cp > ends[i]!) continue;
      if (cp < starts[i]!) return 0;
      if (ranges[i] === 0) return (cp + deltas[i]!) & 0xffff;
      const pos = rangeOff + i * 2 + ranges[i]! + (cp - starts[i]!) * 2;
      const g = view.getUint16(pos);
      if (g === 0) return 0;
      return (g + deltas[i]!) & 0xffff;
    }
    return 0;
  };
}

/** One styled run after `§` parsing. */
export interface PaintRun {
  text: string;
  /** `#rrggbb`. Default white. */
  color?: string;
  bold?: boolean;
  italic?: boolean;
}

/** Options for {@link layoutRuns}. */
export interface LayoutPaint {
  shadow?: boolean;
  /** CSS pixel scale. 1 design pixel → this many CSS pixels. */
  guiScale: number;
  fontScale?: number;
  /** Wrap width in design pixels, before CSS/gui scaling. */
  maxWidth?: number;
}

/**
 * Lay a string of runs onto a design-pixel image (shadow included).
 *
 * @param font - Parsed face.
 * @param runs - Styled text.
 * @param paint - Scale / shadow.
 * @returns RGBA image in design pixels, plus the CSS display size.
 */
export function layoutRuns(
  font: MojanglesFont,
  runs: PaintRun[],
  paint: LayoutPaint,
): {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  cssW: number;
  cssH: number;
} {
  const scale = paint.fontScale ?? 1;
  const lines = splitRuns(runs).flatMap((line) =>
    wrapPaintLine(font, line, paint.maxWidth),
  );
  const laid = lines.map((line) => layoutLine(font, line));
  const contentW = laid.reduce(
    (m, l) => Math.max(m, paint.maxWidth ? lineInkWidth(l) : l.width),
    1,
  );
  const shadow = paint.shadow ? 1 : 0;
  const linePitch = Math.max(CELL_PX, LABEL_LINE_FOR_PAINT);
  const w = contentW + shadow;
  const h = Math.max(1, lines.length) * linePitch + shadow;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let li = 0; li < laid.length; li++) {
    const y0 = li * linePitch;
    stampLine(rgba, w, h, laid[li]!, y0, shadow);
  }
  const gui = paint.guiScale * scale;
  return {
    rgba,
    w,
    h,
    cssW: Math.max(1, w * gui),
    cssH: Math.max(1, h * gui),
  };
}

/** Line box used when stacking runs. Matches JSON UI's 9gui line. */
const LABEL_LINE_FOR_PAINT = 9;

interface Placed {
  x: number;
  adv: number;
  on: Uint8Array;
  color: [number, number, number];
  italicShift: number;
}

interface LaidLine {
  width: number;
  glyphs: Placed[];
}

/**
 * @param runs - Segments, possibly containing `\n`.
 * @returns one run-list per line.
 */
function splitRuns(runs: PaintRun[]): PaintRun[][] {
  const lines: PaintRun[][] = [[]];
  for (const run of runs) {
    const parts = run.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1]!.push({ ...run, text: part });
    });
  }
  return lines;
}

/**
 * Wrap one styled paragraph using actual glyph advances, preserving colors
 * and bold/italic state across inserted line breaks.
 * @param font - Parsed Mojangles face.
 * @param runs - One paragraph's styled runs.
 * @param maxWidth - Optional design-pixel width.
 * @returns One or more wrapped lines.
 */
function wrapPaintLine(
  font: MojanglesFont,
  runs: PaintRun[],
  maxWidth?: number,
): PaintRun[][] {
  if (!(maxWidth && maxWidth > 0)) return [runs];
  const lines: PaintRun[][] = [];
  let line: PaintRun[] = [];
  for (const run of runs)
    for (const text of run.text) {
      line.push({ ...run, text });
      if (line.length < 2 || lineInkWidth(layoutLine(font, line)) <= maxWidth)
        continue;
      if (/\s/.test(text)) {
        lines.push(line.slice(0, -1));
        line = [];
        continue;
      }
      let split = -1;
      for (let i = line.length - 2; i >= 0; i--)
        if (/\s/.test(line[i]!.text)) {
          split = i;
          break;
        }
      if (split > 0) {
        lines.push(line.slice(0, split));
        line = line.slice(split + 1);
      } else {
        lines.push(line.slice(0, -1));
        line = line.slice(-1);
      }
    }
  if (line.length || lines.length === 0) lines.push(line);
  return lines;
}

/**
 * @param font - Face.
 * @param runs - One line, no newlines.
 * @returns placements and pen width (design px).
 */
function layoutLine(font: MojanglesFont, runs: PaintRun[]): LaidLine {
  const glyphs: Placed[] = [];
  let pen = 0;
  for (const run of runs) {
    const color = parseHex(run.color ?? "#ffffff");
    for (const ch of run.text) {
      const cp = ch.codePointAt(0)!;
      const sheet = spriteFor(cp);
      if (sheet) {
        glyphs.push({
          x: pen,
          adv: sheet.adv,
          on: sheet.on,
          color: sheet.color ?? color,
          italicShift: 0,
        });
        pen += sheet.adv + (sheet.touch ? 1 : 0);
        continue;
      }
      const g = font.glyph(cp);
      const adv = g.adv + (run.bold ? 1 : 0);
      const on = boldOn(g, run.bold === true);
      glyphs.push({
        x: pen,
        adv,
        on,
        color,
        italicShift: run.italic ? 1 : 0,
      });
      const touch = run.bold ? true : g.touch;
      pen += adv + (touch && adv > 0 ? 1 : 0);
    }
  }
  return { width: Math.max(pen, 1), glyphs };
}

/**
 * Stamp a glyph a second time one design pixel to the right (`§l`).
 *
 * @param g - Source mask.
 * @param bold - Whether to double-strike.
 * @returns on-mask whose column count is `g.adv` or `g.adv+1`.
 */
function boldOn(g: GlyphMask, bold: boolean): Uint8Array {
  if (!bold || g.adv === 0) return g.on;
  const adv = g.adv + 1;
  const on = new Uint8Array(CELL_PX * adv);
  for (let j = 0; j < CELL_PX; j++) {
    for (let i = 0; i < g.adv; i++) {
      if (!g.on[j * g.adv + i]) continue;
      on[j * adv + i] = 1;
      on[j * adv + i + 1] = 1;
    }
  }
  return on;
}

/**
 * @param rgba - Destination.
 * @param w - Image width.
 * @param h - Image height.
 * @param line - Glyphs.
 * @param y0 - Top row of this line.
 * @param shadow - 1 when a shadow should be stamped.
 */
function stampLine(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  line: LaidLine,
  y0: number,
  shadow: number,
): void {
  const paint = (dx: number, dy: number, shadowPass: boolean): void => {
    for (const g of line.glyphs) {
      const [r, gc, b] = shadowPass ? shadowOf(g.color) : g.color;
      const cols = g.on.length / CELL_PX;
      for (let j = 0; j < CELL_PX; j++) {
        const shift = g.italicShift && j < 4 ? 1 : 0;
        const y = y0 + j + dy;
        if (y < 0 || y >= h) continue;
        for (let i = 0; i < cols; i++) {
          if (!g.on[j * cols + i]) continue;
          const x = g.x + i + dx + shift;
          if (x < 0 || x >= w) continue;
          const at = (y * w + x) * 4;
          rgba[at] = r;
          rgba[at + 1] = gc;
          rgba[at + 2] = b;
          rgba[at + 3] = 255;
        }
      }
    }
  };
  if (shadow) paint(1, 1, true);
  paint(0, 0, false);
}

/**
 * Bedrock shadow is the text colour × 0.25 per channel, fully opaque.
 *
 * @param rgb - Text colour.
 * @returns shadow colour. 255 → 64, 84 → 21.
 */
export function shadowOf(
  rgb: [number, number, number],
): [number, number, number] {
  return [
    Math.round(rgb[0] * 0.25),
    Math.round(rgb[1] * 0.25),
    Math.round(rgb[2] * 0.25),
  ];
}

/**
 * @param css - `#rgb`, `#rrggbb`, or `rgb()`.
 * @returns 0–255 channels. Unknown colours become white.
 */
export function parseHex(css: string): [number, number, number] {
  const s = css.trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1]!;
    const full =
      h.length === 3
        ? h
            .split("")
            .map((c) => c + c)
            .join("")
        : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [255, 255, 255];
}

/**
 * Measure plain (or `§`-stripped) text in gui pixels.
 *
 * @param text - One or more lines.
 * @param fontScale - `font_scale_factor` multiplier.
 * @returns width and height in gui px, or null when the font is not loaded.
 */
export function measureMojangles(
  text: string,
  fontScale: number,
): { w: number; h: number } | null {
  if (!parsed) return null;
  const lines = text.length ? text.split("\n") : [""];
  let max = 1;
  for (const line of lines) {
    max = Math.max(max, inkWidth(parsed, line));
  }
  const scale = fontScale > 0 ? fontScale : 1;
  return {
    w: max * scale,
    h: Math.max(1, lines.length) * LABEL_LINE_FOR_PAINT * scale,
  };
}

/**
 * Width of the ink, not the trailing letter-spacing gap.
 *
 * @param font - Face.
 * @param line - One line, no format codes.
 * @returns design pixels from the origin through the last ink column.
 */
/**
 * Truncate one line with `...` so its design-pixel ink fits `maxDesignPx`.
 * Newlines are left alone. `§` / `&` codes stay in the kept prefix.
 *
 * @param font - Face.
 * @param text - One label string.
 * @param maxDesignPx - Max ink width in design pixels (gui px / font scale).
 * @returns text, or a shorter string ending in `...`.
 */
export function ellipsizePlain(
  font: MojanglesFont,
  text: string,
  maxDesignPx: number,
): string {
  if (!(maxDesignPx > 0) || text.includes("\n")) return text;
  const plain = text.replace(/[§&]./g, "");
  if (inkWidth(font, plain) <= maxDesignPx) return text;
  const dots = "...";
  if (inkWidth(font, dots) > maxDesignPx) return "";
  // Keep whole words. "..." may run one pixel past the box; the label clips.
  // Probe cell I: 156-wide box ends at "fox...", not mid-number.
  const words = plain.split(" ");
  let kept = "";
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const next = kept.length === 0 ? word : `${kept} ${word}`;
    if (inkWidth(font, next) > maxDesignPx + 1) break;
    kept = next;
  }
  if (kept.length > 0 && kept !== plain) {
    return takeVisiblePrefix(text, Array.from(kept).length) + dots;
  }
  const chars = Array.from(plain);
  let n = chars.length;
  while (
    n > 0 &&
    inkWidth(font, chars.slice(0, n).join("") + dots) > maxDesignPx
  ) {
    n--;
  }
  return takeVisiblePrefix(text, n) + dots;
}

/**
 * {@link ellipsizePlain} against the loaded face. Returns `text` when the
 * face is not loaded.
 *
 * @param text - Label text.
 * @param maxGuiWidth - Box width in gui px.
 * @param fontScale - Effective font scale.
 * @returns fitting text.
 */
export function ellipsizeMojangles(
  text: string,
  maxGuiWidth: number,
  fontScale: number,
): string {
  if (!parsed) return text;
  const scale = fontScale > 0 ? fontScale : 1;
  return ellipsizePlain(parsed, text, maxGuiWidth / scale);
}

/**
 * Prefix of `text` covering `count` visible code points. Skips `§` codes.
 *
 * @param text - Raw label text.
 * @param count - Visible characters to keep.
 * @returns raw prefix.
 */
function takeVisiblePrefix(text: string, count: number): string {
  let seen = 0;
  let i = 0;
  while (i < text.length && seen < count) {
    const ch = text[i]!;
    if ((ch === "§" || ch === "&") && i + 1 < text.length) {
      i += 2;
      continue;
    }
    const cp = text.codePointAt(i) ?? 0;
    i += cp > 0xffff ? 2 : 1;
    seen++;
  }
  return text.slice(0, i);
}

function inkWidth(font: MojanglesFont, line: string): number {
  return lineInkWidth(layoutLine(font, [{ text: line }]));
}

/** Visible ink extent excludes the trailing pen spacing after the last glyph. */
function lineInkWidth(laid: LaidLine): number {
  let end = 0;
  for (const g of laid.glyphs) {
    const cols = g.on.length / CELL_PX;
    for (let j = 0; j < CELL_PX; j++) {
      const shift = g.italicShift && j < 4 ? 1 : 0;
      for (let i = 0; i < cols; i++) {
        if (g.on[j * cols + i]) end = Math.max(end, g.x + i + shift + 1);
      }
    }
  }
  return Math.max(end, 1);
}

/**
 * Rasterize runs to a pixelated canvas. Null when the face is not loaded
 * or there is no DOM.
 *
 * @param runs - Styled text.
 * @param paint - Scale and shadow.
 * @returns canvas whose CSS size is guiScale × the design grid.
 */
export function renderMojanglesCanvas(
  runs: PaintRun[],
  paint: LayoutPaint,
): HTMLCanvasElement | null {
  if (!parsed || typeof document === "undefined") return null;
  const laid = layoutRuns(parsed, runs, paint);
  const canvas = document.createElement("canvas");
  canvas.width = laid.w;
  canvas.height = laid.h;
  canvas.style.width = `${laid.cssW}px`;
  canvas.style.height = `${laid.cssH}px`;
  canvas.style.imageRendering = "pixelated";
  canvas.style.display = "block";
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const pixels = new Uint8ClampedArray(laid.rgba.length);
  pixels.set(laid.rgba);
  ctx.putImageData(new ImageData(pixels, laid.w, laid.h), 0, 0);
  return canvas;
}

/** True after a successful parse. */
export function mojanglesLoaded(): boolean {
  return parsed !== null;
}

/**
 * Plain-text bitmask for tests (no shadow). Rows are `CELL_PX` strings of
 * `#` / `.`.
 *
 * @param font - Face.
 * @param text - One line.
 * @returns ink rows (7 visible + descender) and ink width.
 */
export function rasterPlainLine(
  font: MojanglesFont,
  text: string,
): { width: number; rows: string[] } {
  const laid = layoutLine(font, [{ text }]);
  const width = inkWidth(font, text);
  const rows: string[] = [];
  for (let j = 0; j < CELL_PX; j++) {
    const chars = new Array<string>(width).fill(".");
    for (const g of laid.glyphs) {
      const cols = g.on.length / CELL_PX;
      for (let i = 0; i < cols; i++) {
        const x = g.x + i;
        if (x < width && g.on[j * cols + i]) chars[x] = "#";
      }
    }
    rows.push(chars.join(""));
  }
  return { width, rows };
}

/**
 * Hub URL for the TTF. `base` is the same origin the viewer uses for `/packs`.
 *
 * @param base - Hub origin, no trailing slash.
 * @returns font URL.
 */
export function mojanglesFontUrl(base: string): string {
  return `${base.replace(/\/$/, "")}/font/Mojangles.ttf`;
}

/**
 * Fetch, parse, and register `@font-face`. One warning on failure; the
 * caller keeps {@link MOJANGLES_STACK} so the page falls back to system UI.
 *
 * @param base - Hub origin.
 * @returns true when outlines were parsed.
 */
export async function ensureMojangles(base: string): Promise<boolean> {
  if (!readyPromise) readyPromise = loadFace(base);
  return readyPromise;
}

/**
 * @param base - Hub origin.
 * @returns whether outlines loaded.
 */
async function loadFace(base: string): Promise<boolean> {
  const win = globalThis as {
    __mojanglesReady?: boolean;
    __mojanglesLoaded?: boolean;
    __bedrockBitmapFontLoaded?: boolean;
  };
  try {
    const url = mojanglesFontUrl(base);
    installFontFace(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET /font/Mojangles.ttf → ${res.status}`);
    parsed = parseMojangles(await res.arrayBuffer());
    win.__bedrockBitmapFontLoaded = await loadDefaultBitmap(base, parsed);
    if (typeof document !== "undefined" && document.fonts?.load) {
      await document.fonts.load(`10px "${MOJANGLES_FAMILY}"`);
    }
    await loadGlyphAtlas(base);
    win.__mojanglesLoaded = true;
    return true;
  } catch (err) {
    if (!warned.current) {
      warned.current = true;
      console.warn(
        "[mojangles] font unavailable; labels use the system fallback",
        err,
      );
    }
    win.__mojanglesLoaded = false;
    return false;
  } finally {
    win.__mojanglesReady = true;
  }
}

/** Pack override wins; otherwise use the installed-client atlas in FontDir. */
async function loadDefaultBitmap(
  base: string,
  font: MojanglesFont,
): Promise<boolean> {
  const root = base.replace(/\/$/, "");
  for (const path of ["/asset/font/default8.png", "/font/default8.png"]) {
    try {
      const response = await fetch(root + path);
      if (!response.ok) continue;
      const bitmap = await createImageBitmap(await response.blob());
      try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) continue;
        context.drawImage(bitmap, 0, 0);
        const info = await fetch(root + path.replace(/\.png$/, ".json"));
        const metadata = info.ok ? await info.json() : {};
        installDefaultBitmap(
          font,
          context.getImageData(0, 0, bitmap.width, bitmap.height).data,
          bitmap.width,
          bitmap.height,
          metadata,
        );
        return true;
      } finally {
        bitmap.close();
      }
    } catch {
      // A missing/invalid atlas leaves the known outline fallback available.
    }
  }
  console.warn(
    "[mojangles] native default8.png unavailable; using outline fallback",
  );
  return false;
}

/**
 * @param url - TTF URL on the hub.
 */
function installFontFace(url: string): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("mojangles-face")) return;
  const style = document.createElement("style");
  style.id = "mojangles-face";
  style.textContent = `@font-face{font-family:"${MOJANGLES_FAMILY}";src:url("${url}") format("truetype");font-display:block;}`;
  document.head.appendChild(style);
}

/** Custom-glyph page pixels. Higher packs already won via `/asset`. */
interface GlyphPage {
  cell: number;
  w: number;
  data: Uint8ClampedArray;
}

const pages = new Map<string, GlyphPage>();

/**
 * Pull `font/glyph_XX.png` through the pack stack (`/asset` = later pack wins).
 *
 * @param base - Hub origin.
 */
async function loadGlyphAtlas(base: string): Promise<void> {
  if (typeof document === "undefined") return;
  const root = base.replace(/\/$/, "");
  let idx: Record<string, string>;
  try {
    const res = await fetch(`${root}/packs/index`);
    if (!res.ok) return;
    idx = (await res.json()) as Record<string, string>;
  } catch {
    return;
  }
  const paths = Object.keys(idx).filter((p) =>
    /^font\/glyph_[0-9a-f]{2}\.png$/i.test(p),
  );
  await Promise.all(
    paths.map(async (path) => {
      const m = path.match(/glyph_([0-9a-f]{2})/i);
      if (!m) return;
      const key = m[1]!.toUpperCase();
      try {
        const rel = path
          .split("/")
          .map((s) => encodeURIComponent(s))
          .join("/");
        const res = await fetch(`${root}/asset/${rel}`);
        if (!res.ok) return;
        const bmp = await createImageBitmap(await res.blob());
        const canvas = document.createElement("canvas");
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(bmp, 0, 0);
        const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
        pages.set(key, { cell: bmp.width / 16, w: bmp.width, data });
        bmp.close();
      } catch {
        /* one missing page does not drop the rest */
      }
    }),
  );
}

interface Sprite {
  adv: number;
  on: Uint8Array;
  touch: boolean;
  /** Sheet RGB when the glyph is a coloured bitmap (gender / shiny). */
  color: [number, number, number] | null;
}

/**
 * Pack glyph sheet cell for a private-use code point.
 *
 * U+XXYZ → `glyph_XX.png` cell row Y, column Z. Advance is the count of
 * non-transparent columns scaled to an 8-unit glyph, plus 1 unit of spacing.
 * The cell is drawn so it maps onto the 8px cell (the calibrated em grid).
 *
 * @param cp - Code point.
 * @returns sprite, or null when no page is loaded.
 */
function spriteFor(cp: number): Sprite | null {
  if (cp < 0xe000 || cp > 0xf8ff) return null;
  const page = (cp >>> 8).toString(16).toUpperCase().padStart(2, "0");
  const sheet = pages.get(page);
  if (!sheet || sheet.cell <= 0) return null;
  const low = cp & 0xff;
  const row = (low >>> 4) & 0xf;
  const col = low & 0xf;
  const cell = sheet.cell;
  const x0 = col * cell;
  const y0 = row * cell;
  let minC = cell;
  let maxC = -1;
  let sheetRgb: [number, number, number] | null = null;
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const o = ((y0 + y) * sheet.w + (x0 + x)) * 4;
      const a = sheet.data[o + 3]!;
      if (a >= 128) {
        if (!sheetRgb) {
          sheetRgb = [sheet.data[o]!, sheet.data[o + 1]!, sheet.data[o + 2]!];
        }
        if (x < minC) minC = x;
        if (x > maxC) maxC = x;
      }
    }
  }
  if (maxC < 0) {
    return { adv: 1, on: new Uint8Array(CELL_PX), touch: false, color: null };
  }
  const srcW = maxC - minC + 1;
  // Scale the ink box, not the empty left of the cell. Gender marks sit
  // mid-cell; sampling only the left `adv` columns draws nothing.
  const drawW = Math.max(1, Math.round((srcW * CELL_PX) / cell));
  const adv = drawW + 1;
  const on = new Uint8Array(CELL_PX * adv);
  let rgb: [number, number, number] | null = null;
  for (let j = 0; j < CELL_PX; j++) {
    const sy = Math.min(cell - 1, Math.floor((j * cell) / CELL_PX));
    for (let i = 0; i < drawW; i++) {
      const sx = minC + Math.min(srcW - 1, Math.floor((i * srcW) / drawW));
      const o = ((y0 + sy) * sheet.w + (x0 + sx)) * 4;
      const a = sheet.data[o + 3]!;
      if (a >= 128) {
        on[j * adv + i] = 1;
        if (!rgb) {
          rgb = [sheet.data[o]!, sheet.data[o + 1]!, sheet.data[o + 2]!];
        }
      }
    }
  }
  let touch = false;
  for (let j = 0; j < CELL_PX; j++) if (on[j * adv + adv - 1]) touch = true;
  return { adv, on, touch, color: rgb ?? sheetRgb };
}

/** Test hook: forget a loaded face so a second fetch can run. */
export function resetMojanglesForTests(): void {
  parsed = null;
  readyPromise = null;
  warned.current = false;
  pages.clear();
}

/** Em size in design pixels (documented for the calibration script). */
export const MOJANGLES_EM_PX = EM_PX;
