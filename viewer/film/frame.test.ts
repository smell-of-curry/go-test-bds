import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import type { Page } from "playwright";
import { presentFilmFrame } from "./frame";

test("HUD readiness serializes into an independent browser realm", async () => {
  class LoadedImage {
    complete = true;
    naturalWidth = 16;
  }
  const realm = createContext({
    window: {
      __viewer: { pendingModelLoads: 0, jsonUiReady: true },
      __film: { present: () => "canvas" },
      __mojanglesReady: true,
      __mojanglesLoaded: true,
    },
    document: {
      querySelector: () => null,
      fonts: { status: "loaded" },
      body: { querySelectorAll: () => [{ getClientRects: () => [{}] }] },
    },
    getComputedStyle: () => ({
      display: "block",
      visibility: "visible",
      backgroundImage: 'url("texture.png")',
      borderImageSource: "none",
    }),
    Image: LoadedImage,
    HTMLImageElement: LoadedImage,
  });
  const png = Buffer.from("composited PNG");
  const page = {
    evaluate: async (fn: Function) =>
      runInContext(`(${fn.toString()})()`, realm),
    screenshot: async () => png,
  } as unknown as Page;
  assert.equal(
    await presentFilmFrame(page, true, 1_000),
    png.toString("base64"),
  );
});

test("a slow first terrain present does not consume the pixel-settling window", async () => {
  const realNow = Date.now;
  let wall = realNow();
  let presents = 0;
  const png = Buffer.from("stable viewport");
  Date.now = () => wall;
  try {
    const page = {
      evaluate: async (fn: Function) => {
        const source = fn.toString();
        if (source.includes("pendingModelLoads")) return 0;
        if (source.includes(".present()")) {
          if (++presents === 1) wall += 2_000;
          return "canvas";
        }
        return { ready: true, note: "ready" };
      },
      screenshot: async () => png,
    } as unknown as Page;
    assert.equal(
      await presentFilmFrame(page, true, 1_000),
      png.toString("base64"),
    );
    assert.equal(presents, 2);
  } finally {
    Date.now = realNow;
  }
});
