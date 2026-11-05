/**
 * Unit tests for JSON UI image UV / texture-info helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  absolutePaintLayer,
  colorChannels,
  fitImageBackgroundCss,
  imageKeepsRatio,
  labelClipsWithEllipsis,
  lookupTextureInfo,
  ninesliceCenterIsEmpty,
  ninesliceCss,
  paintChildOrder,
  resolveImageUv,
  uvBackgroundCss,
  type JsonUiAssets,
} from "./dom.js";

describe("ninesliceCss", () => {
  it("scales a horizontal arrow's end caps with its height", () => {
    const css = ninesliceCss(
      [7, 0, 1, 0],
      2,
      { w: 16, h: 13, baseSize: [16, 13] },
      { w: 64, h: 64 },
    );
    assert.equal(css.slice, "0 1 0 7 fill");
    assert.equal(css.width, "0px 4.923px 0px 34.462px");
  });
  it("maps design slice sizes into high-resolution texture pixels", () => {
    const css = ninesliceCss(
      1,
      2,
      { w: 10, h: 10, baseSize: [5, 5] },
      { w: 40, h: 20 },
    );
    assert.deepEqual(css, { slice: "2 2 2 2 fill", width: "2px 2px 2px 2px" });
  });
  it("scales a vertical-only slice symmetrically", () => {
    const css = ninesliceCss(
      [0, 7, 0, 1],
      2,
      { w: 13, h: 16 },
      { w: 64, h: 64 },
    );
    assert.equal(css.width, "34.462px 0px 4.923px 0px");
  });
});

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
    assert.deepEqual(resolveImageUv("@widget.anim__talk_start", true), [0, 0]);
  });

  it("returns null without uv_size", () => {
    assert.equal(resolveImageUv("@widget.anim__ringing", false), null);
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

describe("imageKeepsRatio", () => {
  it("defaults true and only an explicit false stretches", () => {
    assert.equal(imageKeepsRatio(undefined), true);
    assert.equal(imageKeepsRatio(true), true);
    assert.equal(imageKeepsRatio("true"), true);
    assert.equal(imageKeepsRatio(false), false);
    assert.equal(imageKeepsRatio("false"), false);
  });
});

describe("fitImageBackgroundCss", () => {
  it("fills a wide box while preserving the source ratio when fill is true", () => {
    const css = fitImageBackgroundCss(
      { w: 8, h: 8 },
      null,
      null,
      { w: 640, h: 100 },
      true,
      true,
    );
    assert.equal(css.size, "640px 640px");
    assert.equal(css.position, "0px -270px");
  });

  it("aspect-fits an 8×8 texture into a 1920×1080 screen, centered", () => {
    const css = fitImageBackgroundCss(
      { w: 8, h: 8 },
      null,
      null,
      {
        w: 1920,
        h: 1080,
      },
      true,
    );
    assert.equal(css.size, "1080px 1080px");
    assert.equal(css.position, "420px 0px");
  });

  it("aspect-fits a 1:2 checker into a 2:1 box", () => {
    const css = fitImageBackgroundCss(
      { w: 16, h: 32 },
      null,
      null,
      {
        w: 120,
        h: 60,
      },
      true,
    );
    assert.equal(css.size, "30px 60px");
    assert.equal(css.position, "45px 0px");
  });

  it("uses uv_size aspect, not the full texture", () => {
    const css = fitImageBackgroundCss(
      { w: 16, h: 32 },
      [0, 0],
      [8, 8],
      {
        w: 64,
        h: 32,
      },
      true,
    );
    assert.equal(css.size, "64px 128px");
    assert.equal(css.position, "16px 0px");
  });

  it("stretches when keep_ratio is false", () => {
    const css = fitImageBackgroundCss(
      { w: 16, h: 32 },
      null,
      null,
      {
        w: 120,
        h: 60,
      },
      false,
    );
    assert.equal(css.size, "120px 60px");
    assert.equal(css.position, "0px 0px");
  });
});

describe("colorChannels", () => {
  it("recognizes vanilla named colors for labels and image tint", () => {
    assert.deepEqual(colorChannels("black"), [0, 0, 0]);
    assert.deepEqual(colorChannels("white"), [1, 1, 1]);
    assert.deepEqual(colorChannels(["black"]), [0, 0, 0]);
  });

  it("preserves numeric colors and rejects unresolved names", () => {
    assert.deepEqual(colorChannels([0.5, 1, 0]), [0.5, 1, 0]);
    assert.equal(colorChannels("$unresolved"), null);
    assert.equal(colorChannels(["$unresolved", 1, 0]), null);
  });
});

describe("labelClipsWithEllipsis", () => {
  it("clips a one-line box and skips wrap targets", () => {
    assert.equal(labelClipsWithEllipsis("The quick", 8, 1, undefined), true);
    assert.equal(labelClipsWithEllipsis("a\nb", 8, 1, undefined), false);
    assert.equal(labelClipsWithEllipsis("The quick", 12, 1, 60), false);
    assert.equal(labelClipsWithEllipsis("The quick", 18, 1, undefined), false);
  });
});

describe("absolutePaintLayer", () => {
  it("adds layer to the parent", () => {
    assert.equal(absolutePaintLayer(0, 0), 0);
    assert.equal(absolutePaintLayer(2, -1), 1);
    assert.equal(absolutePaintLayer(4, 3), 7);
  });

  it("puts a vanilla button label above button_image", () => {
    // common_buttons.new_ui_button_panel layer 1:
    //   button_image layer 1
    //   button_content (layer 0)
    //     button_content_panel layer 3
    //       content layer 2
    const panel = absolutePaintLayer(0, 1);
    const image = absolutePaintLayer(panel, 1);
    const content = absolutePaintLayer(panel, 0);
    const typePanel = absolutePaintLayer(content, 3);
    const label = absolutePaintLayer(typePanel, 2);
    assert.ok(label > image, `label=${label} image=${image}`);
  });
});

describe("paintChildOrder", () => {
  it("sorts by layer then declaration index", () => {
    const ordered = paintChildOrder([
      { layer: 1, name: "button_image" },
      { layer: 0, name: "button_content" },
      { layer: 1, name: "border" },
    ]);
    assert.deepEqual(
      ordered.map((row) => row.name),
      ["button_content", "button_image", "border"],
    );
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
    const info = lookupTextureInfo("textures/ui/widgets/loop", {
      assets: { textureUrl: (p) => p },
      textureSizes: { "textures/ui/widgets/loop": { w: 512, h: 64 } },
    });
    assert.equal(info?.w, 512);
    assert.equal(info?.h, 64);
  });
});
