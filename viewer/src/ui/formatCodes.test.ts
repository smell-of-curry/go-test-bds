import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapMinecraftGlyphs, stripFormatCodes } from "./formatCodes.js";
import { resolveLabelFontScale } from "./jsonui/dom.js";

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

describe("resolveLabelFontScale", () => {
  it("reads numeric and string font_scale_factor", () => {
    assert.equal(resolveLabelFontScale({ font_scale_factor: 0.5 }), 0.5);
    assert.equal(resolveLabelFontScale({ font_scale_factor: "0.7" }), 0.7);
  });
  it("multiplies font_size enum", () => {
    assert.equal(
      resolveLabelFontScale({ font_scale_factor: 1, font_size: "large" }),
      1.25,
    );
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
