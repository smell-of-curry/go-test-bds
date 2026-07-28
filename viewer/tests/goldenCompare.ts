/**
 * Perceptual-ish PNG golden comparison for Stage 12 visual regression.
 *
 * A pixel "differs" when any channel delta exceeds CHANNEL_DELTA (8/255).
 * Fail when differing pixels exceed MAX_DIFF_FRACTION (0.5%) of the image.
 *
 * Env:
 *   GOLDEN_UPDATE=1  — rewrite goldens instead of asserting
 *   GOLDEN_SOFT=1    — report diffs but do not fail (local Windows escape;
 *                      CI stays strict). Soft does not create missing goldens.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";

/** Max |channel| delta (0–255) before a pixel counts as differing. */
export const CHANNEL_DELTA = 8;
/** Fail when more than this fraction of pixels differ. */
export const MAX_DIFF_FRACTION = 0.005;

export interface CompareResult {
  width: number;
  height: number;
  totalPixels: number;
  differingPixels: number;
  differingFraction: number;
  /** Red-highlight diff PNG bytes (same size), or null when identical. */
  diffPng: Buffer | null;
}

/**
 * Decode a PNG buffer to RGBA.
 *
 * @param buf - PNG file bytes.
 * @returns decoded image.
 */
export function decodePng(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

/**
 * Encode RGBA into a PNG buffer.
 *
 * @param png - Image with width/height/data.
 * @returns PNG file bytes.
 */
export function encodePng(png: PNG): Buffer {
  return PNG.sync.write(png);
}

/**
 * Compare two PNG buffers with the Stage 12 thresholds.
 *
 * @param actual - Screenshot bytes.
 * @param expected - Golden bytes.
 * @returns comparison stats + optional diff image.
 * @throws if dimensions differ.
 */
export function comparePngs(actual: Buffer, expected: Buffer): CompareResult {
  const a = decodePng(actual);
  const e = decodePng(expected);
  if (a.width !== e.width || a.height !== e.height) {
    throw new Error(
      `golden size mismatch: actual ${a.width}x${a.height} vs golden ${e.width}x${e.height}`,
    );
  }

  const totalPixels = a.width * a.height;
  let differingPixels = 0;
  const diff = new PNG({ width: a.width, height: a.height });

  for (let i = 0; i < totalPixels; i++) {
    const o = i * 4;
    const dr = Math.abs(a.data[o]! - e.data[o]!);
    const dg = Math.abs(a.data[o + 1]! - e.data[o + 1]!);
    const db = Math.abs(a.data[o + 2]! - e.data[o + 2]!);
    const da = Math.abs(a.data[o + 3]! - e.data[o + 3]!);
    const differs =
      dr > CHANNEL_DELTA ||
      dg > CHANNEL_DELTA ||
      db > CHANNEL_DELTA ||
      da > CHANNEL_DELTA;
    if (differs) {
      differingPixels++;
      // Magenta highlight on dark actual luminance so diffs are obvious in review.
      diff.data[o] = 255;
      diff.data[o + 1] = 0;
      diff.data[o + 2] = 255;
      diff.data[o + 3] = 255;
    } else {
      const lum = (a.data[o]! + a.data[o + 1]! + a.data[o + 2]!) / 3;
      const dim = Math.round(lum * 0.35);
      diff.data[o] = dim;
      diff.data[o + 1] = dim;
      diff.data[o + 2] = dim;
      diff.data[o + 3] = 255;
    }
  }

  const differingFraction = differingPixels / totalPixels;
  return {
    width: a.width,
    height: a.height,
    totalPixels,
    differingPixels,
    differingFraction,
    diffPng: differingPixels > 0 ? encodePng(diff) : null,
  };
}

export interface AssertGoldenOptions {
  /** Absolute path to the checked-in golden PNG. */
  goldenPath: string;
  /** Absolute directory for actual/diff artefacts on mismatch. */
  resultsDir: string;
  /** Shot name used in artefact filenames (e.g. `overview`). */
  name: string;
  /** Screenshot PNG bytes. */
  actual: Buffer;
}

/**
 * Assert (or update / soft-report) a golden screenshot.
 *
 * @param opts - Paths and screenshot bytes.
 */
export function assertGolden(opts: AssertGoldenOptions): void {
  const update = process.env.GOLDEN_UPDATE === "1";
  const soft = process.env.GOLDEN_SOFT === "1";

  if (update) {
    mkdirSync(dirname(opts.goldenPath), { recursive: true });
    writeFileSync(opts.goldenPath, opts.actual);
    return;
  }

  if (!existsSync(opts.goldenPath)) {
    throw new Error(
      `missing golden for "${opts.name}" at ${opts.goldenPath}. ` +
        `Regenerate with: GOLDEN_UPDATE=1 npx playwright test golden`,
    );
  }

  const expected = readFileSync(opts.goldenPath);
  const result = comparePngs(opts.actual, expected);
  if (result.differingFraction <= MAX_DIFF_FRACTION) return;

  mkdirSync(opts.resultsDir, { recursive: true });
  const actualPath = `${opts.resultsDir}/${opts.name}.actual.png`;
  const diffPath = `${opts.resultsDir}/${opts.name}.diff.png`;
  writeFileSync(actualPath, opts.actual);
  if (result.diffPng) writeFileSync(diffPath, result.diffPng);

  const pct = (result.differingFraction * 100).toFixed(3);
  const msg =
    `golden "${opts.name}" differs: ${pct}% pixels ` +
    `(${result.differingPixels}/${result.totalPixels}) exceed Δ${CHANNEL_DELTA}. ` +
    `Wrote ${actualPath}` +
    (result.diffPng ? ` and ${diffPath}` : "") +
    `. Accept with GOLDEN_UPDATE=1.`;

  if (soft) {
    console.warn(`[GOLDEN_SOFT] ${msg}`);
    return;
  }
  throw new Error(msg);
}
