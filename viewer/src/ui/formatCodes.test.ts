import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapMinecraftGlyphs, stripFormatCodes } from "./formatCodes.js";

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
