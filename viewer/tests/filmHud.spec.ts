import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { presentFilmFrame } from "../film/frame";

let vite: ViteDevServer;
let base: string;
test.beforeAll(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await vite.listen();
  base = vite.resolvedUrls!.local[0]!;
});
test.afterAll(async () => {
  await vite?.close();
});
test.beforeEach(async ({ page }) => {
  await page.route("**/film-hud-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  const fontDir = process.env.GOTESTBDS_VIEWER_FONT_DIR;
  if (fontDir) {
    if (existsSync(join(fontDir, "default8.png"))) {
      await page.route("**/font/default8.png", (route) =>
        route.fulfill({
          contentType: "image/png",
          body: readFileSync(join(fontDir, "default8.png")),
        }),
      );
      await page.route("**/font/default8.json", (route) =>
        existsSync(join(fontDir, "default8.json"))
          ? route.fulfill({
              contentType: "application/json",
              body: readFileSync(join(fontDir, "default8.json")),
            })
          : route.fulfill({ status: 404, body: "missing" }),
      );
    }
    await page.route("**/font/Mojangles.ttf", (route) =>
      route.fulfill({
        contentType: "font/ttf",
        body: readFileSync(join(fontDir, "Mojangles.ttf")),
      }),
    );
  }
  await page.goto(`${base}film-hud-test`);
  if (fontDir) {
    expect(
      await page.evaluate(async () => {
        const { ensureMojangles } = await import("/src/ui/mojangles.ts");
        return ensureMojangles(location.origin);
      }),
    ).toBe(true);
  }
});

test("native bitmap font keeps regular strokes thin and bold explicitly heavier", async ({
  page,
}) => {
  const fontDir = process.env.GOTESTBDS_VIEWER_FONT_DIR;
  test.skip(
    !fontDir || !existsSync(join(fontDir, "default8.png")),
    "requires installed native bitmap font",
  );
  const result = await page.evaluate(async () => {
    const { renderMojanglesCanvas } = await import("/src/ui/mojangles.ts");
    const regular = renderMojanglesCanvas([{ text: "W" }], { guiScale: 1 });
    const bold = renderMojanglesCanvas([{ text: "W", bold: true }], {
      guiScale: 1,
    });
    const row = (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return "missing";
      const data = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, 1).data;
      return Array.from({ length: canvas.width }, (_, x) =>
        data[x * 4 + 3] ? "#" : ".",
      )
        .join("")
        .replace(/\.+$/, "");
    };
    return { regular: row(regular), bold: row(bold) };
  });
  expect(result).toEqual({ regular: "#...#", bold: "##..##" });
});

test("a nested HUD mount obeys native ancestor visibility and stack padding", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { buildResolver } = await import("/src/ui/jsonui/resolve.ts");
    const { parseUiRawFile } = await import("/src/ui/jsonui/load.ts");
    const { createHudRenderer } = await import("/src/ui/jsonui/hud.ts");
    const { Store } = await import("/src/store.ts");
    const resolver = buildResolver([
      {
        packId: "probe",
        path: "ui/hud.json",
        raw: parseUiRawFile({
          namespace: "hud",
          root_panel: {
            type: "panel",
            bindings: [
              {
                binding_name: "#hud_visible",
                binding_name_override: "#visible",
              },
            ],
            controls: [
              {
                chat_stack: {
                  type: "stack_panel",
                  orientation: "vertical",
                  size: [100, 100],
                  anchor_from: "top_left",
                  anchor_to: "top_left",
                  offset: [4, 12],
                  controls: [
                    { padding: { type: "panel", size: [1, 6] } },
                    {
                      position: {
                        type: "label",
                        text: "position",
                        size: [80, 10],
                      },
                    },
                  ],
                },
              },
            ],
          },
          "root_panel/chat_stack": {
            modifications: [
              {
                control_name: "position",
                operation: "insert_after",
                value: [
                  { status: { type: "label", text: "status", size: [80, 10] } },
                ],
              },
            ],
          },
        })!,
      },
    ]);
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;inset:0";
    document.body.append(host);
    let visible = false;
    const hud = createHudRenderer(resolver, host, {
      assets: { textureUrl: (path) => path },
      guiScale: 2,
      extension: {
        hudScreens: [
          { id: "status", namespace: "hud", name: "status", wrapStack: true },
        ],
        seedGlobals: (_, set) => set("#hud_visible", visible),
      },
    });
    const store = new Store();
    hud.onFrame(store.getState());
    const hidden = host.querySelectorAll('[data-ui-name="status"]').length;
    visible = true;
    hud.onFrame(store.getState());
    const labels = host.querySelectorAll('[data-ui-name="status"]');
    const box = labels[0]?.getBoundingClientRect();
    return { hidden, count: labels.length, x: box?.x, y: box?.y };
  });
  expect(result).toEqual({ hidden: 0, count: 1, x: 8, y: 56 });
});

test("extension forms render their registered screen, not vanilla long_form", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { parseUiRawFile } = await import("/src/ui/jsonui/load.ts");
    const { buildResolver } = await import("/src/ui/jsonui/resolve.ts");
    const { createFormRenderer } = await import("/src/ui/jsonui/forms.ts");
    const resolver = buildResolver([
      {
        packId: "fixture",
        path: "ui/battle.json",
        raw: parseUiRawFile({
          namespace: "battle",
          main: { type: "label", text: "CHOOSE YOUR MOVE", size: [160, 30] },
        }),
      },
      {
        packId: "fixture",
        path: "ui/server_form.json",
        raw: parseUiRawFile({
          namespace: "server_form",
          long_form: {
            type: "label",
            text: "WRONG GENERIC FORM",
            size: [160, 30],
          },
        }),
      },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const forms = createFormRenderer({
      resolver,
      host,
      assets: { textureUrl: (p: string) => p },
      formRoutes: [{ flag: "§b§a§t§l§e", screen: "battle.main" }],
    });
    forms.show({
      type: "action",
      title: "§b§a§t§l§e",
      content: "Turn 1",
      buttons: ["Tackle"],
    });
    return {
      screen: forms.lastRoute?.screen,
      text: host.textContent,
      scrim: !!host.querySelector(".jsonui-form-scrim"),
    };
  });
  expect(result).toEqual({
    screen: "battle.main",
    text: "CHOOSE YOUR MOVE",
    scrim: false,
  });
});

test("same-title form content updates repaint the current form", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { createJsonUiRuntime } = await import("/src/ui/jsonui/runtime.ts");
    const { Store } = await import("/src/store.ts");
    const runtime = createJsonUiRuntime({
      assetBaseUrl: "",
      extension: null,
      client: {
        getPacks: async () => [],
        fetchPackJson: async () => null,
        fetchPackText: async () => null,
      },
    });
    await runtime.ready;
    const state = new Store().getState();
    state.ui = {
      title: "",
      subtitle: "",
      actionBar: "",
      form: {
        type: "action",
        title: "Battle",
        content: "Turn 1",
        buttons: ["Tackle"],
      },
    };
    runtime.onFrame(state);
    (window as any).__formFixture = { runtime, state };
  });
  await expect(page.locator(".jh-form-content")).toHaveText("Turn 1");
  await page.evaluate(() => {
    const { runtime, state } = (window as any).__formFixture;
    state.ui.form.content = "Turn 2: Super effective!";
    runtime.onFrame(state);
  });
  await expect(page.locator(".jh-form-content")).toHaveText(
    "Turn 2: Super effective!",
  );
  await page.evaluate(() => {
    const { runtime, state } = (window as any).__formFixture;
    state.ui.form = null;
    runtime.onFrame(state);
  });
  await expect(page.locator(".jh-form")).toHaveCount(0);
});

test("HUD capture includes DOM pixels and waits for ready UI without advancing film time", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 180 });
  const texture = new PNG({ width: 1, height: 1 });
  texture.data.set([0, 255, 128, 255]);
  let releaseTexture!: () => void;
  const textureGate = new Promise<void>((resolve) => {
    releaseTexture = resolve;
  });
  await page.route("**/paused-ui.png", async (route) => {
    await textureGate;
    await route.fulfill({
      contentType: "image/png",
      body: PNG.sync.write(texture),
    });
  });
  await page.setContent(
    `<style>body{margin:0}canvas{position:absolute;inset:0}#json-hud{position:absolute;left:20px;top:20px;width:100px;height:50px;background:#ff00ff url('${base}paused-ui.png')}</style><canvas width="320" height="180"></canvas><div id="json-hud">Battle form</div>`,
    { waitUntil: "domcontentloaded" },
  );
  await page.clock.install({ time: new Date(0) });
  await page.clock.pauseAt(new Date(0));
  await page.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#003399";
    ctx.fillRect(0, 0, 320, 180);
    (window as any).__film = {
      present: () => canvas.toDataURL("image/png").split(",")[1],
    };
    (window as any).__viewer = { pendingModelLoads: 0, jsonUiReady: false };
    (window as any).__mojanglesReady = true;
    (window as any).__mojanglesLoaded = true;
  });
  const before = await page.evaluate(() => Date.now());
  let finished = false;
  const capture = presentFilmFrame(page, true, 10_000).then((png) => {
    finished = true;
    return png;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(
    finished,
    "must not capture a text-only startup frame before UI is ready",
  ).toBe(false);
  await page.evaluate(() => {
    (window as any).__viewer.jsonUiReady = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(finished, "must wait for the asynchronously loaded CSS texture").toBe(
    false,
  );
  releaseTexture();
  const png = PNG.sync.read(Buffer.from(await capture, "base64"));
  expect([png.width, png.height]).toEqual([320, 180]);
  const pixel = (x: number, y: number) => [
    ...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4),
  ];
  expect(pixel(110, 60)).toEqual([0, 255, 128, 255]);
  expect(pixel(200, 100)).toEqual([0, 51, 153, 255]);
  expect(await page.evaluate(() => Date.now())).toBe(before);
  const canvasOnly = PNG.sync.read(
    Buffer.from(await presentFilmFrame(page), "base64"),
  );
  expect([
    ...canvasOnly.data.subarray((60 * 320 + 110) * 4, (60 * 320 + 110) * 4 + 4),
  ]).toEqual([0, 51, 153, 255]);
});

test("HUD capture fails clearly when Mojangles is unavailable", async ({
  page,
}) => {
  await page.evaluate(() => {
    (window as any).__film = { present: () => "canvas-png" };
    (window as any).__viewer = { jsonUiReady: true };
    (window as any).__mojanglesReady = true;
    (window as any).__mojanglesLoaded = false;
  });
  await expect(presentFilmFrame(page, true, 2_000)).rejects.toThrow(
    "Mojangles unavailable",
  );
});

test("JSON UI readiness stays false until first-paint texture preloads finish", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/asset/**", async (route) => {
    requested();
    await gate;
    await route.fulfill({ status: 404, body: "fixture has no texture" });
  });
  await page.evaluate(async () => {
    const { createJsonUiRuntime } = await import("/src/ui/jsonui/runtime.ts");
    (window as any).__runtimeFixture = createJsonUiRuntime({
      assetBaseUrl: location.origin,
      extension: null,
      client: {
        getPacks: async () => [],
        fetchPackJson: async () => null,
        fetchPackText: async () => null,
      },
    });
  });
  await started;
  try {
    expect(
      await page.evaluate(
        () => (window as any).__runtimeFixture.getResolver() !== null,
      ),
    ).toBe(false);
  } finally {
    release();
  }
  await page.evaluate(() => (window as any).__runtimeFixture.ready);
  expect(
    await page.evaluate(
      () => (window as any).__runtimeFixture.getResolver() !== null,
    ),
  ).toBe(true);
});

test("same-label button icons and form types update without stale previous form", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { createJsonUiRuntime } = await import("/src/ui/jsonui/runtime.ts");
    const { Store } = await import("/src/store.ts");
    const doc = {
      namespace: "server_form",
      icon: {
        type: "image",
        size: [16, 16],
        texture: "#texture",
        bindings: [
          {
            binding_type: "collection",
            binding_collection_name: "form_buttons",
            binding_name: "#form_button_texture",
            binding_name_override: "#texture",
          },
        ],
      },
      long_form: {
        type: "grid",
        size: [200, 30],
        collection_name: "form_buttons",
        grid_item_template: "server_form.icon",
        grid_dimensions: [1, 1],
      },
      custom_form: { type: "label", size: [200, 30], text: "Custom screen" },
    };
    const runtime = createJsonUiRuntime({
      assetBaseUrl: "",
      extension: null,
      client: {
        getPacks: async () => [{ id: "fixture" }],
        fetchPackJson: async (_id: string, path: string) =>
          path.endsWith("_ui_defs.json")
            ? { ui_defs: ["ui/server_form.json"] }
            : path.endsWith("server_form.json")
              ? doc
              : null,
        fetchPackText: async () => null,
      },
    });
    await runtime.ready;
    const state = new Store().getState();
    state.ui = {
      form: {
        type: "action",
        title: "Selection",
        content: "",
        buttons: ["Choose"],
        buttonImages: ["textures/ui/first"],
      },
    };
    runtime.onFrame(state);
    (window as any).__iconFixture = { runtime, state };
  });
  await expect(page.locator(".jsonui-image-face").first()).toHaveCSS(
    "background-image",
    /first\.png/,
  );
  await page.evaluate(() => {
    const { runtime, state } = (window as any).__iconFixture;
    state.ui.form.buttonImages = ["textures/ui/second"];
    runtime.onFrame(state);
  });
  await expect(page.locator(".jsonui-image-face").first()).toHaveCSS(
    "background-image",
    /second\.png/,
  );
  await page.evaluate(() => {
    const { runtime, state } = (window as any).__iconFixture;
    state.ui.form.type = "custom";
    state.ui.form.content = "[]";
    runtime.onFrame(state);
  });
  await expect(
    page.locator('[data-jsonui-name="server_form.custom_form"]'),
  ).toContainText("Custom screen");
  await expect(
    page.locator('[data-jsonui-name="server_form.long_form"]'),
  ).toHaveCount(0);
});

test("form hover uses pack textures and clears when the form is replaced", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { buildResolver } = await import("/src/ui/jsonui/resolve.ts");
    const { parseUiRawFile } = await import("/src/ui/jsonui/load.ts");
    const { createFormRenderer } = await import("/src/ui/jsonui/forms.ts");
    const resolver = buildResolver([
      {
        packId: "fixture",
        path: "ui/menu.json",
        raw: parseUiRawFile({
          namespace: "menu",
          main: {
            type: "panel",
            collection_index: 0,
            size: [100, 30],
            controls: [
              {
                button: {
                  type: "button",
                  size: [100, 30],
                  default_control: "idle",
                  hover_control: "focus",
                  controls: [
                    {
                      idle: {
                        type: "image",
                        texture: "textures/idle",
                        size: [100, 30],
                        $default_state: true,
                      },
                    },
                    {
                      focus: {
                        type: "image",
                        texture: "textures/focus",
                        size: [100, 30],
                        $hover_state: true,
                        controls: [
                          {
                            tip: {
                              type: "custom",
                              renderer: "hover_text_renderer",
                              bindings: [
                                {
                                  binding_name: "#form_text",
                                  binding_name_override: "#hover_text",
                                },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      },
    ]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const forms = createFormRenderer({
      resolver,
      host,
      assets: { textureUrl: (p: string) => p + ".png" },
      formRoutes: [{ flag: "MENU", screen: "menu.main" }],
    });
    const form = {
      type: "action",
      title: "MENU",
      content: "Power: 40\nAccuracy: 100%",
      buttons: ["Select"],
    };
    forms.show(form);
    (window as any).__hoverFixture = { forms, form };
  });
  await expect(page.locator(".jsonui-image-face")).toHaveCSS(
    "background-image",
    /idle\.png/,
  );
  await page.evaluate(() => (window as any).__hoverFixture.forms.hover(0));
  await expect(page.locator(".jsonui-image-face")).toHaveCSS(
    "background-image",
    /focus\.png/,
  );
  const tooltip = page.locator(".jsonui-hover-tooltip");
  await expect(tooltip).toContainText("Power: 40");
  await expect(tooltip).toContainText("Accuracy: 100%");
  await expect(tooltip).toHaveAttribute("data-anchor-mode", "recorded-button");
  await page.mouse.move(40, 40);
  await expect(tooltip).toHaveAttribute("data-anchor-mode", "pointer");
  await page.evaluate(() => {
    const { forms, form } = (window as any).__hoverFixture;
    forms.show(form);
  });
  await expect(page.locator(".jsonui-image-face")).toHaveCSS(
    "background-image",
    /idle\.png/,
  );
  await expect(tooltip).toHaveCount(0);
});

test("a dynamically bound form image loads its natural size and repaints aspect fit", async ({
  page,
}) => {
  const png = new PNG({ width: 8, height: 4 });
  png.data.fill(255);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/asset/**", async (route) => {
    if (route.request().url().endsWith("/textures/menu/wide.png")) {
      requested();
      await gate;
      await route.fulfill({
        contentType: "image/png",
        body: PNG.sync.write(png),
      });
    } else await route.fulfill({ status: 404, body: "missing fixture asset" });
  });
  await page.evaluate(async () => {
    const { createJsonUiRuntime } = await import("/src/ui/jsonui/runtime.ts");
    const { Store } = await import("/src/store.ts");
    const doc = {
      namespace: "menu",
      main: {
        type: "image",
        texture: "textures/menu/wide",
        size: [100, 100],
        keep_ratio: true,
      },
    };
    const runtime = createJsonUiRuntime({
      assetBaseUrl: location.origin,
      extension: { formRoutes: [{ flag: "MENU", screen: "menu.main" }] },
      client: {
        getPacks: async () => [{ id: "fixture" }],
        fetchPackJson: async (_id: string, path: string) =>
          path.endsWith("_ui_defs.json")
            ? { ui_defs: ["ui/menu.json"] }
            : path.endsWith("menu.json")
              ? doc
              : null,
        fetchPackText: async () => null,
      },
    });
    await runtime.ready;
    const state = new Store().getState();
    state.ui = {
      form: { type: "action", title: "MENU", content: "", buttons: [] },
    };
    runtime.onFrame(state);
  });
  await started;
  try {
    expect(
      await page.evaluate(() => (window as any).__jsonUiTexturesPending),
    ).toBeGreaterThan(0);
  } finally {
    release();
  }
  await expect(page.locator(".jsonui-image-face")).toHaveCSS(
    "background-size",
    "200px 100px",
  );
  await expect(page.locator(".jsonui-image-face")).toHaveCSS(
    "background-position",
    "0px 50px",
  );
  await page.waitForFunction(
    () => (window as any).__jsonUiTexturesPending === 0,
  );
});

test("a recorded custom form without buttons does not crash the hidden diagnostic overlay", async ({
  page,
}) => {
  const text = await page.evaluate(async () => {
    const { Overlay } = await import("/src/overlay.ts");
    const { Store } = await import("/src/store.ts");
    const nodes = Array.from({ length: 4 }, () =>
      document.createElement("div"),
    );
    const overlay = new Overlay(...nodes);
    const state = new Store().getState();
    // The Go snapshot omits an empty buttons slice on ModalForm/custom forms.
    state.ui = {
      form: { type: "custom", title: "Challenge trainer", content: "[]" },
    };
    overlay.render(state, "first", {
      blockInstanceCount: 0,
      sectionMeshCount: 0,
    });
    return nodes[3].textContent;
  });
  expect(text).toContain("Challenge trainer");
});

test("high HUD control layers stay beneath the active form screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 180 });
  await page.evaluate(async () => {
    const { createJsonUiRuntime } = await import("/src/ui/jsonui/runtime.ts");
    const runtime = createJsonUiRuntime({
      assetBaseUrl: "",
      extension: null,
      client: {
        getPacks: async () => [],
        fetchPackJson: async () => null,
        fetchPackText: async () => null,
      },
    });
    await runtime.ready;
    const hud = document.createElement("div");
    hud.style.cssText =
      "position:fixed;inset:0;background:rgb(255,0,0);z-index:9999";
    runtime.root.querySelector(".jsonui-hud-layer").appendChild(hud);
    const form = document.createElement("div");
    form.style.cssText =
      "position:fixed;inset:20px;background:rgb(0,255,0);z-index:1";
    runtime.root.querySelector(".jsonui-forms-host").appendChild(form);
  });
  const png = PNG.sync.read(await page.screenshot());
  expect([
    ...png.data.subarray((90 * 320 + 160) * 4, (90 * 320 + 160) * 4 + 4),
  ]).toEqual([0, 255, 0, 255]);
});

test("filled image faces cover their box and named black labels remain legible", async ({
  page,
}) => {
  const pixels = new PNG({ width: 1, height: 1 });
  pixels.data.set([255, 255, 255, 255]);
  const texture = `data:image/png;base64,${PNG.sync.write(pixels).toString("base64")}`;
  await page.setViewportSize({ width: 320, height: 180 });
  await page.evaluate(async (texture) => {
    const { buildResolver } = await import("/src/ui/jsonui/resolve.ts");
    const { parseUiRawFile } = await import("/src/ui/jsonui/load.ts");
    const { layoutTree } = await import("/src/ui/jsonui/layout.ts");
    const { renderTree } = await import("/src/ui/jsonui/dom.ts");
    document.body.style.margin = "0";
    const resolver = buildResolver([
      {
        packId: "test",
        path: "ui/paint.json",
        raw: parseUiRawFile({
          namespace: "paint",
          root: {
            type: "image",
            size: [320, 80],
            anchor_from: "top_left",
            anchor_to: "top_left",
            texture: "textures/test/white",
            keep_ratio: true,
            fill: true,
            color: [1, 0, 0],
            controls: [
              {
                label: {
                  type: "label",
                  text: "Move name",
                  color: "black",
                  size: [100, 20],
                  layer: 1,
                },
              },
            ],
          },
        }),
      },
    ]);
    renderTree(
      layoutTree(
        resolver.resolve("paint", "root"),
        { width: 320, height: 180 },
        { measureText: () => ({ w: 80, h: 9 }) },
      ),
      document.body,
      {
        guiScale: 1,
        assets: {
          textureUrl: () => texture,
          textureInfo: () => ({ w: 1, h: 1 }),
        },
      },
    );
  }, texture);
  await expect(page.locator(".jsonui-label")).toHaveCSS(
    "color",
    "rgb(0, 0, 0)",
  );
  const shot = PNG.sync.read(await page.screenshot());
  for (const x of [1, 318]) {
    const at = (20 * shot.width + x) * 4;
    expect([...shot.data.slice(at, at + 3)]).toEqual([255, 0, 0]);
  }
});

test("Mojangles body labels wrap the pixel canvas within the authored width", async ({
  page,
}) => {
  test.skip(
    !process.env.GOTESTBDS_VIEWER_FONT_DIR,
    "requires installed Mojangles",
  );
  const result = await page.evaluate(async () => {
    const { buildResolver } = await import("/src/ui/jsonui/resolve.ts");
    const { parseUiRawFile } = await import("/src/ui/jsonui/load.ts");
    const { layoutTree } = await import("/src/ui/jsonui/layout.ts");
    const { renderTree } = await import("/src/ui/jsonui/dom.ts");
    const { measureMojangles } = await import("/src/ui/mojangles.ts");
    const raw = parseUiRawFile({
      namespace: "body",
      root: {
        type: "label",
        text: "§cFirst §9second third",
        size: [48, 60],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
    });
    const resolver = buildResolver([
      { packId: "fixture", path: "ui/body.json", raw },
    ]);
    renderTree(
      layoutTree(
        resolver.resolve("body", "root"),
        { width: 320, height: 180 },
        { measureText: measureMojangles },
      ),
      document.body,
      { guiScale: 2, assets: { textureUrl: (p) => p } },
    );
    const canvas = document.querySelector(".jsonui-label canvas");
    return {
      width: canvas.width,
      height: canvas.height,
      text: document.querySelector(".jsonui-label").textContent,
    };
  });
  expect(result.width).toBeLessThanOrEqual(48);
  expect(result.height).toBe(27);
  expect(result.text).toBe("First second third");
});

test("bold authored tooltips wrap inside their painted background", async ({
  page,
}) => {
  test.skip(
    !process.env.GOTESTBDS_VIEWER_FONT_DIR,
    "requires installed Mojangles",
  );
  const result = await page.evaluate(async () => {
    const { mountFormTooltip } = await import("/src/ui/jsonui/tooltip.ts");
    const { measureMojangles } = await import("/src/ui/mojangles.ts");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const text =
      "§lUses the user's Defense stat as Attack in damage calculation. Extra details wrap safely.";
    mountFormTooltip(
      host,
      {
        visible: true,
        layer: 1,
        box: { x: 500, y: 300, w: 100, h: 30 },
        children: [],
        element: {
          name: "details",
          namespace: "fixture",
          type: "custom",
          controls: [],
          bindings: [],
          props: { renderer: "hover_text_renderer", hover_text: text },
        },
      },
      2,
      (text, scale) => measureMojangles(text.replace(/§./g, ""), scale),
    );
    const tip = host.querySelector(".jsonui-hover-tooltip");
    const canvas = tip.querySelector("canvas");
    const bounds = tip.getBoundingClientRect();
    const ink = canvas.getBoundingClientRect();
    return {
      canvasWidth: ink.width,
      backgroundWidth: Number.parseFloat(tip.style.width),
      canvasHeight: ink.height,
      backgroundHeight: Number.parseFloat(tip.style.height),
      left: bounds.left,
      right: bounds.right,
      viewport: innerWidth,
    };
  });
  expect(result.canvasWidth).toBe(result.backgroundWidth);
  expect(result.canvasHeight).toBe(result.backgroundHeight);
  expect(result.canvasWidth).toBeLessThanOrEqual(640);
  expect(result.left).toBeGreaterThanOrEqual(4);
  expect(result.right).toBeLessThanOrEqual(result.viewport - 4);
});

test("recorded tick-zero chat expires before a late film window without hiding fresh chat", async ({
  page,
}) => {
  const joins = [
    "§e%multiplayer.player.joined FilmCam",
    "§e%multiplayer.player.joined FilmCam3",
  ];
  const frames = [
    {
      v: 1,
      type: "hello",
      bot: "FilmCam2",
      schema: 1,
      tickRate: 20,
      radius: 8,
    },
    {
      v: 1,
      type: "keyframe",
      bot: "FilmCam2",
      tick: 0,
      world: {},
      actor: null,
      columns: [],
      entities: [],
      ui: { messages: joins },
    },
    {
      v: 1,
      type: "chat",
      bot: "FilmCam2",
      tick: 8671,
      text: "§aReady to battle",
    },
    {
      v: 1,
      type: "delta",
      bot: "FilmCam2",
      tick: 8672,
      ui: { messages: [...joins, "§aReady to battle"] },
    },
  ];
  await page.route("**/film/sse**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: frames
        .map(
          (frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
        )
        .join(""),
    }),
  );
  const result = await page.evaluate(async () => {
    const { initHud } = await import("/src/ui/hud.ts");
    const { Store } = await import("/src/store.ts");
    const { installFilmMode } = await import("/film/client.ts");
    let lang: Record<string, string> | undefined;
    const hud = initHud({ particles: {} as any, getLang: () => lang });
    const store = new Store();
    store.subscribe((state) => hud.onFrame(state));
    installFilmMode({
      applyFrame: (frame) => store.apply(frame),
      paint: () => hud.tick(performance.now()),
      canvas: document.createElement("canvas"),
      hideChrome: () => {},
      glFinish: () => {},
      setCameraTrack: () => {},
    });
    while (!window.__film!.loaded)
      await new Promise((resolve) => setTimeout(resolve, 1));
    const film = window.__film!;
    film.applyThrough(0);
    const initialCount = hud.chatCount;
    lang = { "multiplayer.player.joined": "%s joined the game" };
    film.setNow(5000);
    hud.tick(performance.now());
    const translated = document.querySelector(".hud-chat")!.textContent;
    film.setNow(10_500);
    hud.tick(performance.now());
    const fadingAlpha = (
      document.querySelector(".hud-chat-line") as HTMLElement
    ).style.opacity;
    film.setNow(11_000);
    hud.tick(performance.now());
    const expiredCount = hud.chatCount;
    film.setNow(8672 * 50);
    film.applyThrough(8672 * 50);
    hud.tick(performance.now());
    return {
      initialCount,
      translated,
      fadingAlpha,
      expiredCount,
      finalCount: hud.chatCount,
      finalText: document.querySelector(".hud-chat")!.textContent,
    };
  });
  expect(result.initialCount).toBe(2);
  expect(result.translated).toContain("FilmCam3 joined the game");
  expect(Number(result.fadingAlpha)).toBeCloseTo(0.9375);
  expect(result.expiredCount).toBe(0);
  expect(result.finalCount).toBe(1);
  expect(result.finalText).toBe("Ready to battle");
});
