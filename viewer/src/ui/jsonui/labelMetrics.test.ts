/**
 * Label metric helpers — run: `cd viewer ; npx tsx --test src/ui/jsonui/labelMetrics.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LABEL_FONT_SIZE_GUI,
  LABEL_LINE_HEIGHT_GUI,
  collapseLangPercentEscapes,
  resolveLabelFontScale,
} from "./labelMetrics";

describe("labelMetrics constants", () => {
  it("keeps 9gui line box = 8gui font * 1.125", () => {
    assert.equal(LABEL_FONT_SIZE_GUI, 8);
    assert.equal(LABEL_LINE_HEIGHT_GUI, 9);
    assert.equal(LABEL_LINE_HEIGHT_GUI / LABEL_FONT_SIZE_GUI, 1.125);
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

describe("collapseLangPercentEscapes", () => {
  it("collapses battle HP 100%% to 100%", () => {
    assert.equal(collapseLangPercentEscapes("100%%"), "100%");
    assert.equal(collapseLangPercentEscapes("G0.0⠀100%%"), "G0.0⠀100%");
  });
  it("leaves single % alone", () => {
    assert.equal(collapseLangPercentEscapes("G0%"), "G0%");
  });
  it("no-ops when %% absent", () => {
    assert.equal(collapseLangPercentEscapes("hello"), "hello");
  });
});
