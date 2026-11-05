import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapMinecraftGlyphs,
  parseFormatCodes,
  stripFormatCodes,
} from "./formatCodes.js";

describe("Bedrock formatting", () => {
  it("uses emerald HP color and resets it for the following level", () => {
    const runs = parseFormatCodes("§qHP: 321/321§r§e Lv. 100");
    assert.equal(runs[0]!.color, "#13a045");
    assert.equal(runs[0]!.text, "HP: 321/321");
    assert.equal(runs[1]!.color, "#ffff55");
  });
  it("uses material colors for m/n without Java text decorations", () => {
    const runs = parseFormatCodes("§l§mRedstone§nCopper§rPlain");
    assert.equal(runs[0]!.color, "#ee222c");
    assert.equal(runs[1]!.color, "#c87363");
    assert.equal(runs[0]!.strike, false);
    assert.equal(runs[1]!.underline, false);
    assert.equal(runs[1]!.bold, true);
    assert.equal(runs[2]!.bold, false);
    assert.equal(runs[2]!.color, undefined);
  });
  it("recognizes the other extended material codes without dropping text", () => {
    const runs = parseFormatCodes("§gG§hH§iI§jJ§pP§sS§tT§uU");
    assert.equal(runs.map((r) => r.text).join(""), "GHIJPSTU");
    assert.ok(runs.every((r) => /^#[a-f0-9]{6}$/.test(r.color ?? "")));
  });
});

describe("mapMinecraftGlyphs", () => {
  it("keeps male/female/shiny PUA for glyph sheets", () => {
    assert.equal(mapMinecraftGlyphs("Bulbasaur\uE108").codePointAt(9), 0xe108);
    assert.equal(mapMinecraftGlyphs("Eevee\uE109").codePointAt(5), 0xe109);
    assert.equal(mapMinecraftGlyphs("Shiny\uE10A").codePointAt(5), 0xe10a);
  });
  it("drops unknown private-use codepoints", () => {
    assert.equal(mapMinecraftGlyphs("X\uE111Y"), "XY");
  });
});

describe("stripFormatCodes + glyphs", () => {
  it("keeps pack glyphs after stripping colours", () => {
    assert.equal(
      mapMinecraftGlyphs(stripFormatCodes("§fBulbasaur\uE108")).codePointAt(9),
      0xe108,
    );
  });
});
