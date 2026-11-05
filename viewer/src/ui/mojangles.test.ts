/**
 * Native default8 bitmap and the optional Mojangles outline fallback.
 * Run: `cd viewer ; npx tsx --test src/ui/mojangles.test.ts`
 * Skips when the TTF is not on disk (Mojang content, not in the repo).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import {
  ellipsizePlain,
  layoutRuns,
  parseMojangles,
  rasterPlainLine,
  shadowOf,
  installDefaultBitmap,
  MojanglesFont,
} from "./mojangles.js";

/** Historical outline mask. This is NOT the native default8 bitmap face. */
const WELCOME = [
  "##..##........##....................................##..............#####.........##...........#####.............##......................##....##",
  "##..##........##....................................##..............##..##........##...........##..##............##......................##....##",
  "##..##..####..##...####...####..#####...####.......####..####.......#####...####..##.##..####..#####...####...#####.#####...####...####..##.##.##",
  "##..##.##..##.##..##..##.##..##.######.##..##.......##..##..##......##.....##..##.####..##..##.##..##.##..##.##.###.###.##.##..##.##..##.####..##",
  "######.######.##..##.....##..##.######.######.......##..##..##......##.....##..##.###...######.##..##.######.##..##.##.....##..##.##.....###...##",
  "######.##.....##..##..##.##..##.##..##.##...........##..##..##......##.....##..##.####..##.....##..##.##.....##..##.##.....##..##.##..##.####....",
  "##..##..#####..##..####...####..##..##..#####........##..####.......##......####..##.##..#####.#####...#####..#####.##......####...####..##.##.##",
];

function fontPath(): string | null {
  const env = process.env.GOTESTBDS_VIEWER_FONT_DIR;
  if (env) {
    const named = `${env.replace(/\/$/, "")}/Mojangles.ttf`;
    if (existsSync(named)) return named;
  }
  return null;
}

describe("shadowOf", () => {
  it("multiplies each channel by 0.25", () => {
    assert.deepEqual(shadowOf([255, 255, 255]), [64, 64, 64]);
    assert.deepEqual(shadowOf([255, 84, 84]), [64, 21, 21]);
  });
});

describe("Mojangles raster", () => {
  const path = fontPath();
  const font = path
    ? parseMojangles(
        (() => {
          const bytes = readFileSync(path);
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          );
        })(),
      )
    : null;

  it(
    "retains the heavier outline fallback when no native bitmap is installed",
    { skip: !font },
    () => {
      const got = rasterPlainLine(font!, "Welcome to PokeBedrock!");
      assert.equal(got.width, WELCOME[0]!.length);
      for (let i = 0; i < WELCOME.length; i++) {
        assert.equal(got.rows[i], WELCOME[i], `row ${i}`);
      }
      assert.equal(got.rows[0]!.slice(0, 6), "##..##");
      assert.equal(got.rows[2]!.slice(7, 13), ".####.");
    },
  );

  it("truncates a line wider than 156gui with ...", { skip: !font }, () => {
    const src = "The quick brown fox 0123456789";
    const out = ellipsizePlain(font!, src, 156);
    assert.equal(out, "The quick brown fox...");
    assert.equal(ellipsizePlain(font!, src, 120), "The quick brown fox...");
    assert.equal(ellipsizePlain(font!, "Hi", 156), "Hi");
  });

  it(
    "wraps a styled canvas at word boundaries using actual glyph advances",
    { skip: !font },
    () => {
      const runs = [
        { text: "First ", color: "#ff0000" },
        { text: "second third", color: "#0000ff" },
      ];
      const full = layoutRuns(font!, runs, { guiScale: 2 });
      const wrapped = layoutRuns(font!, runs, { guiScale: 2, maxWidth: 48 });
      assert.ok(full.w > 48);
      assert.ok(wrapped.w <= 48);
      assert.equal(wrapped.h, 27);
      assert.equal(wrapped.cssH, 54);
      const first = wrapped.rgba.slice(0, wrapped.w * 9 * 4);
      const second = wrapped.rgba.slice(wrapped.w * 9 * 4, wrapped.w * 18 * 4);
      assert.ok(first.some((v, i) => i % 4 === 0 && v === 255));
      assert.ok(second.some((v, i) => i % 4 === 2 && v === 255));
    },
  );

  it(
    "does not wrap a natural-width label because of trailing glyph spacing",
    { skip: !font },
    () => {
      const text = "HP: 321/321 Lv. 100";
      const width = rasterPlainLine(font!, text).width;
      const laid = layoutRuns(font!, [{ text }], {
        guiScale: 2,
        maxWidth: width,
      });
      assert.equal(laid.h, 9);
      assert.equal(laid.w, width);
    },
  );
});

describe("native default8 bitmap", () => {
  it("uses the atlas row pitch and vertical offset instead of outline coverage", () => {
    const pixels = new Uint8Array(128 * 128 * 4);
    // Synthetic W, deliberately unlike any bundled font. Recent atlas format
    // starts each 12px row with three pixels above the normal glyph origin.
    const cp = 87;
    const x = (cp % 16) * 8;
    const y = Math.floor(cp / 16) * 12 + 3;
    for (const dx of [0, 4]) pixels[(y * 128 + x + dx) * 4 + 3] = 255;
    const font = new MojanglesFont(
      () => 0,
      () => null,
    );
    installDefaultBitmap(font, pixels, 128, 128, {
      ascii_character_height: 12,
      ascii_character_y_offset: -3,
    });
    assert.equal(rasterPlainLine(font, "W").rows[0], "#...#");
    assert.equal(font.glyph(32).adv, 4);
    assert.equal(font.glyph(160).adv, 4);
    assert.throws(
      () =>
        installDefaultBitmap(font, pixels, 128, 128, {
          ascii_character_height: 12,
          ascii_character_y_offset: 100,
        }),
      /outside the atlas/,
    );
  });
  const dir = process.env.GOTESTBDS_VIEWER_FONT_DIR;
  const available = dir && existsSync(`${dir}/default8.png`) && fontPath();
  it(
    "matches native single-pixel W/e strokes and explicit bold",
    { skip: !available },
    () => {
      const bytes = readFileSync(fontPath()!);
      const font = parseMojangles(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
      );
      const atlas = PNG.sync.read(readFileSync(`${dir}/default8.png`));
      const meta = existsSync(`${dir}/default8.json`)
        ? JSON.parse(readFileSync(`${dir}/default8.json`, "utf8"))
        : {};
      installDefaultBitmap(font, atlas.data, atlas.width, atlas.height, meta);
      assert.equal(rasterPlainLine(font, "W").rows[0], "#...#");
      assert.equal(rasterPlainLine(font, "e").rows[2], ".###.");
      const bold = layoutRuns(font, [{ text: "W", bold: true }], {
        guiScale: 1,
      });
      const row = Array.from({ length: bold.w }, (_, x) =>
        bold.rgba[x * 4 + 3] ? "#" : ".",
      ).join("");
      assert.equal(row.replace(/\.+$/, ""), "##..##");
      assert.equal(rasterPlainLine(font, "W W").width, 15);
    },
  );
});
