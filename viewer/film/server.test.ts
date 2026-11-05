import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// The offline server is also executable directly by Node.
// @ts-expect-error JS server is not part of the browser TS project.
import { startFilmServer } from "../tools/film-server.mjs";

function fixture(): { root: string; takeDir: string; appDir: string } {
  const root = mkdtempSync(join(tmpdir(), "film-server-ui-"));
  const takeDir = join(root, "take");
  const appDir = join(root, "app");
  mkdirSync(takeDir);
  mkdirSync(appDir);
  writeFileSync(join(appDir, "index.html"), "<html>fixture</html>");
  return { root, takeDir, appDir };
}

test("offline film serves take-local extensions and fonts with MIME and containment", async () => {
  const f = fixture();
  const ext = join(f.takeDir, "extensions");
  const fonts = join(f.takeDir, "fonts");
  mkdirSync(ext);
  mkdirSync(fonts);
  writeFileSync(join(ext, "manifest.json"), '{"modules":["hud.mjs"]}');
  writeFileSync(join(ext, "hud.mjs"), "export default {};");
  writeFileSync(join(fonts, "Mojangles.ttf"), "test-font");
  writeFileSync(join(fonts, "default8.png"), "test-atlas");
  writeFileSync(join(fonts, "default8.json"), '{"ascii_character_height":12}');
  writeFileSync(join(f.root, "outside.ttf"), "private-outside-root");
  symlinkSync(join(f.root, "outside.ttf"), join(fonts, "escape.ttf"));
  symlinkSync(f.root, join(ext, "escape"));
  const server = await startFilmServer(f);
  try {
    assert.deepEqual(await (await fetch(`${server.url}/viewer.json`)).json(), {
      v: 1,
      extensions: "/extensions/",
    });
    const module = await fetch(`${server.url}/extensions/hud.mjs`);
    assert.equal(module.headers.get("content-type"), "text/javascript");
    assert.equal(await module.text(), "export default {};");
    const font = await fetch(`${server.url}/font/Mojangles.ttf`);
    assert.equal(font.headers.get("content-type"), "font/ttf");
    assert.equal(await font.text(), "test-font");
    const atlas = await fetch(`${server.url}/font/default8.png`);
    assert.equal(atlas.headers.get("content-type"), "image/png");
    assert.equal(await atlas.text(), "test-atlas");
    assert.deepEqual(
      await (await fetch(`${server.url}/font/default8.json`)).json(),
      { ascii_character_height: 12 },
    );
    for (const path of ["/font/escape.ttf", "/extensions/escape/outside.ttf"]) {
      assert.equal((await fetch(server.url + path)).status, 404, path);
    }
    for (const path of [
      "/font/nested/font.ttf",
      "/font/test.json",
      "/extensions/%2e%2e%2foutside.ttf",
      "/font/%00.ttf",
    ]) {
      assert.equal((await fetch(server.url + path)).status, 400, path);
    }
  } finally {
    await server.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("explicit extension/font roots override take-local defaults", async () => {
  const f = fixture();
  const extensionsDir = join(f.root, "custom-extensions");
  const fontDir = join(f.root, "host-fonts");
  mkdirSync(extensionsDir);
  mkdirSync(fontDir);
  writeFileSync(join(extensionsDir, "manifest.json"), '{"v":1}');
  writeFileSync(join(fontDir, "Mojangles.ttf"), "host-font");
  const server = await startFilmServer({ ...f, extensionsDir, fontDir });
  try {
    assert.equal(
      (await fetch(`${server.url}/extensions/manifest.json`)).status,
      200,
    );
    assert.equal(
      await (await fetch(`${server.url}/font/Mojangles.ttf`)).text(),
      "host-font",
    );
  } finally {
    await server.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("hub UI resources mirror once and replay with the hub disconnected", async () => {
  const f = fixture();
  const payloads = new Map([
    ["/viewer.json", '{"v":1,"extensions":"/extensions/"}'],
    ["/extensions/manifest.json", '{"modules":["hud.mjs"]}'],
    ["/extensions/hud.mjs", "export default {};"],
    ["/font/Mojangles.ttf", "font-fixture"],
  ]);
  const hub = createServer((req, res) => {
    const body = payloads.get(req.url ?? "");
    res.writeHead(body === undefined ? 404 : 200);
    res.end(body);
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const address = hub.address();
  assert.ok(address && typeof address !== "string");
  let server = await startFilmServer({
    ...f,
    packsFrom: `http://127.0.0.1:${address.port}`,
  });
  try {
    for (const [path, body] of payloads)
      assert.equal(await (await fetch(server.url + path)).text(), body);
    await server.close();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    server = await startFilmServer(f);
    for (const [path, body] of payloads) {
      assert.equal(await (await fetch(server.url + path)).text(), body);
      assert.equal(
        readFileSync(join(f.takeDir, "packs-mirror", path), "utf8"),
        body,
      );
    }
    assert.equal(
      (await fetch(`${server.url}/font/Mojangles.ttf`)).headers.get(
        "content-type",
      ),
      "font/ttf",
    );
  } finally {
    await server.close();
    hub.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("offline pack descriptors inventory UI files for cold form loading", async () => {
  const f = fixture();
  const cacheDir = join(f.root, "cache");
  const pack = join(cacheDir, "packs", "fixture", "1.0");
  mkdirSync(join(pack, "ui"), { recursive: true });
  writeFileSync(join(pack, "manifest.json"), "{}");
  writeFileSync(join(pack, "ui", "menu.json"), '{"namespace":"menu"}');
  writeFileSync(join(pack, "not-ui.json"), "{}");
  writeFileSync(join(f.takeDir, "take.json"), JSON.stringify({ cacheDir }));
  const server = await startFilmServer(f);
  try {
    const packs = await (await fetch(`${server.url}/packs`)).json();
    assert.deepEqual(packs[0].uiFiles, ["ui/menu.json"]);
  } finally {
    await server.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
