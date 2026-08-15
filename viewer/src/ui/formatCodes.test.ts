import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapMinecraftGlyphs, stripFormatCodes } from "./formatCodes.js";

describe("mapMinecraftGlyphs", () => {
  it("maps male/female/shiny PUA to unicode", () => {
    assert.equal(mapMinecraftGlyphs("Bulbasaur"), "Bulbasaur♂");
    assert.equal(mapMinecraftGlyphs("Eevee"), "Eevee♀");
    assert.equal(mapMinecraftGlyphs("Shiny"), "Shiny★");
  });
  it("drops unknown private-use codepoints", () => {
    assert.equal(mapMinecraftGlyphs("XY"), "XY");
  });
});

describe("stripFormatCodes + glyphs", () => {
  it("keeps mapped glyphs after stripping colours", () => {
    assert.equal(
      mapMinecraftGlyphs(stripFormatCodes("§fBulbasaur")),
      "Bulbasaur♂",
    );
  });
});
