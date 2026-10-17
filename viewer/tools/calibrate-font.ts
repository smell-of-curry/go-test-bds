/**
 * Compare Mojangles raster output to the Bedrock GUI-scale-2 chat capture.
 *
 *   cd viewer && GOTESTBDS_VIEWER_FONT_DIR="<dir with Mojangles.ttf>" \
 *     npx tsx tools/calibrate-font.ts
 *
 * Exits 0 and prints SKIP when the TTF is missing. Not a Playwright spec.
 */
import { existsSync, readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { chromium } from "playwright";
import { layoutRuns, parseMojangles, rasterPlainLine } from "../src/ui/mojangles.js";

const DEFAULT_FONT =
  "/Users/eanlowell/Library/Application Support/mcpelauncher/versions/1.26.51.1/assets/assets/fonts/Mojangles.ttf";
const REF =
  "/Users/eanlowell/.cursor/projects/Users-eanlowell-GitHub-pokebedrock-pokebedrock-data/assets/ref-chat-crop.png";

function fontFile(): string | null {
  const dir = process.env.GOTESTBDS_VIEWER_FONT_DIR;
  if (dir) {
    const named = `${dir.replace(/\/$/, "")}/Mojangles.ttf`;
    if (existsSync(named)) return named;
  }
  return existsSync(DEFAULT_FONT) ? DEFAULT_FONT : null;
}

/**
 * Text-only design-pixel rows of "Welcome to PokeBedrock!" in the capture.
 * Crop origin is the chat image; each font pixel is a 2×2 block (GUI scale 2).
 *
 * @param png - Decoded crop.
 * @returns `#` / `.` rows and the ink width.
 */
function referenceWelcome(png: PNG): { rows: string[]; width: number } {
  const text = (x: number, y: number): boolean => {
    const i = (y * png.width + x) * 4;
    const r = png.data[i]!;
    const g = png.data[i + 1]!;
    const b = png.data[i + 2]!;
    return (
      (r === 255 && g === 255 && b === 255) || (r === 255 && g === 84 && b === 84)
    );
  };
  let last = 0;
  const rows: string[] = [];
  for (let j = 0; j < 7; j++) {
    let end = 0;
    const cols: string[] = [];
    for (let i = 0; i < 160; i++) {
      const on = text(4 + i * 2, 62 + j * 2);
      cols.push(on ? "#" : ".");
      if (on) end = i;
    }
    last = Math.max(last, end);
    rows.push(cols.join(""));
  }
  return { rows: rows.map((r) => r.slice(0, last + 1)), width: last + 1 };
}

const file = fontFile();
if (!file || !existsSync(REF)) {
  console.log(
    `SKIP font=${file ?? "missing"} ref=${existsSync(REF) ? "ok" : "missing"}`,
  );
  process.exit(0);
}

const bytes = readFileSync(file);
const font = parseMojangles(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
);
const refPng = PNG.sync.read(readFileSync(REF));
const ref = referenceWelcome(refPng);
const welcome = rasterPlainLine(font, "Welcome to PokeBedrock!");
const hp = rasterPlainLine(font, "HP: 235/235 Lv. 100");

let mism = 0;
for (let j = 0; j < ref.rows.length; j++) {
  const a = welcome.rows[j] ?? "";
  const b = ref.rows[j] ?? "";
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if ((a[i] ?? ".") !== (b[i] ?? ".")) mism++;
}

const laid = layoutRuns(
  font,
  [{ text: "Welcome to PokeBedrock!" }],
  { guiScale: 2, shadow: true },
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  deviceScaleFactor: 1,
  viewport: { width: Math.max(320, laid.cssW + 8), height: 80 },
});
const colors = await page.evaluate(
  ({ rgba, w, h, cssW, cssH }) => {
    const src = document.createElement("canvas");
    src.width = w;
    src.height = h;
    const sctx = src.getContext("2d")!;
    const pixels = new Uint8ClampedArray(rgba);
    sctx.putImageData(new ImageData(pixels, w, h), 0, 0);
    const out = document.createElement("canvas");
    out.width = cssW;
    out.height = cssH;
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.drawImage(src, 0, 0, cssW, cssH);
    const img = ctx.getImageData(0, 0, cssW, cssH).data;
    const counts = new Map<string, number>();
    for (let i = 0; i < img.length; i += 4) {
      const key = `${img[i]},${img[i + 1]},${img[i + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([rgb, n]) => ({ rgb, n }));
  },
  {
    rgba: Array.from(laid.rgba),
    w: laid.w,
    h: laid.h,
    cssW: laid.cssW,
    cssH: laid.cssH,
  },
);
await browser.close();

console.log(
  JSON.stringify(
    {
      font: file,
      units: "design px = 100 font units; guiScale 2 → 2 CSS px per design px",
      emPx: 10,
      cellPx: 8,
      welcomeInkPx: welcome.width,
      referenceInkPx: ref.width,
      welcomeMismatches: mism,
      wColumns: welcome.rows[0]?.slice(0, 6),
      eColumns: welcome.rows[2]?.slice(7, 13),
      refW: ref.rows[0]?.slice(0, 6),
      refE: ref.rows[2]?.slice(7, 13),
      hpInkPx: hp.width,
      hpLine: "HP: 235/235 Lv. 100",
      distinctColors: colors,
      colorCount: colors.length,
    },
    null,
    2,
  ),
);
if (mism !== 0 || welcome.width !== ref.width || colors.length !== 3) {
  process.exit(1);
}
