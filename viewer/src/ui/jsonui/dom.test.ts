/**
 * Unit tests for JSON UI image UV / texture-info helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  lookupTextureInfo,
  ninesliceCenterIsEmpty,
  paintLayerZIndex,
  resolveImageUv,
  uvBackgroundCss,
  type JsonUiAssets,
} from "./dom.js";

describe("resolveImageUv", () => {
  it("keeps numeric uv pairs", () => {
    assert.deepEqual(resolveImageUv([128, 0], true), [128, 0]);
  });

  it("reads initial_uv from flip_book objects", () => {
    assert.deepEqual(
      resolveImageUv({ initial_uv: [64, 0], fps: 8 }, true),
      [64, 0],
    );
  });

  it("falls back to [0,0] when uv is an unresolved @ref and uv_size exists", () => {
    assert.deepEqual(
      resolveImageUv("@phud_phone.anim__oak_talk_start", true),
      [0, 0],
    );
  });

  it("returns null without uv_size", () => {
    assert.equal(resolveImageUv("@phud_phone.anim__ringing", false), null);
  });
});

describe("uvBackgroundCss", () => {
  it("scales a horizontal flipbook strip so one 64px frame fills the element", () => {
    // oak_loop: 512x64, uv_size [64,64], element 64x64 css
    const css = uvBackgroundCss({ w: 512, h: 64 }, [0, 0], [64, 64], {
      w: 64,
      h: 64,
    });
    assert.equal(css.size, "512px 64px");
    assert.equal(css.position, "0px 0px");
  });

  it("offsets later frames via background-position", () => {
    const css = uvBackgroundCss({ w: 512, h: 64 }, [128, 0], [64, 64], {
      w: 32,
      h: 32,
    });
    assert.equal(css.size, "256px 32px");
    assert.equal(css.position, "-64px 0px");
  });
});

describe("paintLayerZIndex", () => {
  it("keeps button_content above button_image chrome", () => {
    assert.equal(paintLayerZIndex("button_image", 1), 1);
    assert.equal(paintLayerZIndex("button_content", 0), 2);
    assert.equal(paintLayerZIndex("main_label", 0), 0);
  });

  it("clamps hollow control layer -1 to 0; leaves other negatives", () => {
    assert.equal(paintLayerZIndex("control", -1), 0);
    assert.equal(paintLayerZIndex("main_label", -1), -1);
  });
});

describe("ninesliceCenterIsEmpty", () => {
  it("detects 2×2 control.png + nineslice 1", () => {
    assert.equal(ninesliceCenterIsEmpty({ w: 2, h: 2 }, 1), true);
  });

  it("keeps real borders with a center", () => {
    assert.equal(ninesliceCenterIsEmpty({ w: 32, h: 32 }, 4), false);
  });
});

describe("lookupTextureInfo", () => {
  const assets: JsonUiAssets = {
    textureUrl: (p) => `${p}.png`,
    textureInfo: (p) =>
      p === "textures/ui/control" ? { w: 2, h: 2, nineslice: 1 } : undefined,
  };

  it("prefers assets.textureInfo nineslice", () => {
    const info = lookupTextureInfo("textures/ui/control", { assets });
    assert.deepEqual(info, { w: 2, h: 2, nineslice: 1 });
  });

  it("merges legacy textureSizes when assets miss", () => {
    const info = lookupTextureInfo("textures/ui/phud/oak_loop", {
      assets: { textureUrl: (p) => p },
      textureSizes: { "textures/ui/phud/oak_loop": { w: 512, h: 64 } },
    });
    assert.equal(info?.w, 512);
    assert.equal(info?.h, 64);
  });
});
