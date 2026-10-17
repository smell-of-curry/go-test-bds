/**
 * One-off: paint phud sidebar at 1920x1080 GUI scale 2.
 * Run from viewer/: npx tsx /tmp/sidebar-shot.mts
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";
import { PNG } from "pngjs";
import { waitForJsonUiPaintReady } from "../tests/jsonUiPaintReady.ts";

const viewerRoot = "/Users/eanlowell/GitHub/pokebedrock/go-test-bds/viewer";
const VANILLA =
  "/Users/eanlowell/Library/Application Support/mcpelauncher/versions/1.26.51.1/assets/assets/resource_packs/vanilla";
const RES = "/Users/eanlowell/GitHub/pokebedrock/pokebedrock-res";
const PHUD =
  "/Users/eanlowell/GitHub/pokebedrock/pokebedrock-beh/src/tests/viewer/phud.mjs";
const FONT = `${process.env.GOTESTBDS_VIEWER_FONT_DIR ?? "/Users/eanlowell/Library/Application Support/mcpelauncher/versions/1.26.51.1/assets/assets/fonts"}/Mojangles.ttf`;
const TOKEN_JSON =
  "/tmp/run751/ui-probe__sidebar-shows-the-bot-party__ui-probe-02-sidebar-jsonui.json";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
} as const;

interface Pack {
  id: string;
  priority: number;
  root: string;
}

const PACKS: Pack[] = [
  { id: "vanilla", priority: 0, root: VANILLA },
  { id: "pokebedrock-res", priority: 1, root: RES },
];

function safeRel(raw: string): string | null {
  const rel = decodeURIComponent(raw).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.split("/").some((p) => p === ".." || p === ".")) return null;
  return rel;
}

function inside(root: string, abs: string): boolean {
  const base = resolve(root);
  const target = resolve(abs);
  return target === base || target.startsWith(base + sep);
}

function readLoose(root: string, rel: string): Buffer | null {
  const abs = join(root, rel);
  if (!inside(root, abs) || !existsSync(abs)) return null;
  try {
    if (!statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return readFileSync(abs);
}

function readUiArchive(root: string): Map<string, Buffer> | null {
  const file = join(root, "__brarchive", "ui.brarchive");
  if (!existsSync(file)) return null;
  const raw = readFileSync(file);
  if (raw.length < 16) return null;
  const count = raw.readUInt32LE(8);
  const stride = 256;
  const base = 16;
  const data0 = base + count * stride;
  if (data0 > raw.length || count > 100_000) return null;
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const rec = base + i * stride;
    const nlen = raw[rec] ?? 0;
    if (nlen <= 0 || nlen > 200) continue;
    const name = raw.subarray(rec + 1, rec + 1 + nlen).toString("utf8");
    const off = raw.readUInt32LE(rec + 248);
    const size = raw.readUInt32LE(rec + 252);
    const start = data0 + off;
    const end = start + size;
    if (start < data0 || end > raw.length) continue;
    out.set(name.toLowerCase(), raw.subarray(start, end));
  }
  return out;
}

const uiArchives = new Map<string, Map<string, Buffer> | null>();

function uiFromArchive(root: string, rel: string): Buffer | null {
  const lower = rel.toLowerCase();
  if (!lower.startsWith("ui/") || !lower.endsWith(".json")) return null;
  let archive = uiArchives.get(root);
  if (archive === undefined) {
    archive = readUiArchive(root);
    uiArchives.set(root, archive);
  }
  if (!archive) return null;
  return archive.get(lower.slice("ui/".length)) ?? null;
}

function readPackFile(root: string, rel: string): Buffer | null {
  return readLoose(root, rel) ?? uiFromArchive(root, rel);
}

function contentType(rel: string): string {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".lang")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".ttf")) return "font/ttf";
  if (lower.endsWith(".mjs") || lower.endsWith(".js"))
    return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function send(
  res: ServerResponse,
  status: number,
  body: Buffer | string,
  type?: string,
): void {
  res.writeHead(status, {
    ...CORS,
    ...(type ? { "content-type": type } : {}),
  });
  res.end(body);
}

function glyphIndex(): Record<string, string> {
  const ordered = PACKS.slice().sort((a, b) => a.priority - b.priority);
  const out: Record<string, string> = {};
  for (const pack of ordered) {
    const dir = join(pack.root, "font");
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^glyph_[0-9a-f]{2}\.png$/i.test(name)) continue;
      out[`font/${name}`] = pack.id;
    }
  }
  return out;
}

function handlePack(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): boolean {
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return true;
  }
  if (pathname === "/font/Mojangles.ttf") {
    if (!existsSync(FONT)) {
      send(res, 404, "no font");
      return true;
    }
    send(res, 200, readFileSync(FONT), "font/ttf");
    return true;
  }
  if (pathname === "/ext/phud.mjs") {
    send(res, 200, readFileSync(PHUD), "text/javascript; charset=utf-8");
    return true;
  }
  if (pathname === "/packs") {
    send(
      res,
      200,
      JSON.stringify(PACKS.map((p) => ({ id: p.id, priority: p.priority }))),
      "application/json",
    );
    return true;
  }
  if (pathname === "/packs/index") {
    send(res, 200, JSON.stringify(glyphIndex()), "application/json");
    return true;
  }
  const packMatch = /^\/pack\/([^/]+)\/(.+)$/.exec(pathname);
  if (packMatch) {
    const id = decodeURIComponent(packMatch[1]!);
    const rel = safeRel(packMatch[2]!);
    const pack = PACKS.find((p) => p.id === id);
    if (!pack || !rel) {
      send(res, 404, "missing");
      return true;
    }
    const body = readPackFile(pack.root, rel);
    if (!body) {
      send(res, 404, "missing");
      return true;
    }
    send(res, 200, body, contentType(rel));
    return true;
  }
  if (pathname.startsWith("/asset/")) {
    const rel = safeRel(pathname.slice("/asset/".length));
    if (!rel) {
      send(res, 404, "missing");
      return true;
    }
    const ordered = PACKS.slice().sort((a, b) => b.priority - a.priority);
    for (const pack of ordered) {
      const body = readPackFile(pack.root, rel);
      if (!body) continue;
      send(res, 200, body, contentType(rel));
      return true;
    }
    send(res, 404, "no asset");
    return true;
  }
  return false;
}

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>sidebar shot</title>
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #1a1428; overflow: hidden; }
      #json-hud { position: fixed; inset: 0; }
      @font-face {
        font-family: "Minecraft";
        src: url("/font/Mojangles.ttf") format("truetype");
        font-display: block;
      }
    </style>
  </head>
  <body>
    <div id="json-hud" class="jsonui-hud-host"></div>
    <script type="module" src="/shot.js"></script>
  </body>
</html>`;

const SHOT_JS = `
import { createHudRenderer } from "/src/ui/jsonui/hud.ts";
import { loadUiFileSet } from "/src/ui/jsonui/load.ts";
import { buildResolver } from "/src/ui/jsonui/resolve.ts";
import { createFetchUiClient } from "/src/ui/jsonui/runtime.ts";
import { ensureMojangles } from "/src/ui/mojangles.ts";
import { viewerExtension } from "/ext/phud.mjs";

const tokens = await (await fetch("/tokens.json")).json();
const sidebar = tokens.sidebar;
const currency = tokens.currency || "";
const playerPing = tokens.playerPing || "";

const FONT = '"Minecraft", ui-sans-serif, system-ui, sans-serif';

function assets() {
  const info = new Map();
  return {
    textureUrl(path) {
      const withExt = /\\.[a-z]{3,4}$/i.test(path) ? path : path + ".png";
      const rel = withExt.replace(/^\\/+/, "").split("/").map(encodeURIComponent).join("/");
      return location.origin + "/asset/" + rel;
    },
    textureInfo(path) {
      return info.get(path.replace(/\\.png$/i, ""));
    },
    info,
  };
}

async function pngSize(buf) {
  if (buf.byteLength < 24) return null;
  const view = new DataView(buf);
  if (view.getUint32(0) !== 0x89504e47) return null;
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

async function main() {
  try {
    await document.fonts.load("16px " + FONT);
  } catch (_) {}
  await document.fonts.ready;
  await ensureMojangles(location.origin);
  const client = createFetchUiClient(location.origin);
  const { files, globals, lang } = await loadUiFileSet(client);
  const resolver = buildResolver(files, globals);
  const host = document.getElementById("json-hud");
  const bag = assets();
  const texPaths = new Set();
  const blob = JSON.stringify(files);
  for (const m of blob.matchAll(/textures\\/[A-Za-z0-9_./-]+/g)) {
    texPaths.add(m[0].replace(/\\.png$/i, ""));
  }
  const paths = [...texPaths];
  for (let i = 0; i < paths.length; i += 12) {
    await Promise.all(paths.slice(i, i + 12).map(async (path) => {
      try {
        const [pngRes, metaRes] = await Promise.all([
          fetch("/asset/" + path + ".png"),
          fetch("/asset/" + path + ".json"),
        ]);
        const meta = metaRes.ok ? await metaRes.json() : null;
        const bytes = pngRes.ok ? await pngRes.arrayBuffer() : null;
        const ihdr = bytes ? await pngSize(bytes) : null;
        const w = ihdr?.w || 0;
        const h = ihdr?.h || 0;
        if (!w && !h && !(meta && meta.nineslice_size !== undefined)) return;
        bag.info.set(path, { w, h, nineslice: meta && meta.nineslice_size });
      } catch (_) {}
    }));
  }
  const renderer = createHudRenderer(resolver, host, {
    assets: bag,
    guiScale: 2,
    viewportCss: { width: 1920, height: 1080 },
    lang,
    extension: viewerExtension,
  });
  renderer.onFrame({
    titleTokens: new Map([
      ["sidebar", sidebar],
      ["currency", currency],
      ["playerPing", playerPing],
    ]),
    ui: { title: "", subtitle: "", actionBar: "" },
    actor: null,
    vitals: null,
    bot: "Bot",
  });
  host.dataset.probeReady = "1";
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack || err.message) : String(err);
  document.body.dataset.probeError = msg;
  console.error(msg);
});
`;

async function main(): Promise<void> {
  const vite = await createViteServer({
    root: viewerRoot,
    configFile: join(viewerRoot, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "custom",
  });
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/shot.html") {
      send(res, 200, PAGE, "text/html; charset=utf-8");
      return;
    }
    if (url.pathname === "/shot.js") {
      send(res, 200, SHOT_JS, "text/javascript; charset=utf-8");
      return;
    }
    if (url.pathname === "/tokens.json") {
      const raw = JSON.parse(readFileSync(TOKEN_JSON, "utf8")) as {
        titleTokens: Record<string, string>;
      };
      send(res, 200, JSON.stringify(raw.titleTokens), "application/json");
      return;
    }
    if (handlePack(req, res, url.pathname)) return;
    vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    });
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no bind");
  const origin = `http://127.0.0.1:${addr.port}`;
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(90_000);
    await page.addInitScript(`globalThis.__name = (fn) => fn;`);
    page.on("pageerror", (err) => console.error(`[pageerror] ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (text.includes("404")) return;
      console.error(`[console] ${text}`);
    });
    await page.goto(`${origin}/shot.html`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForFunction(
      `document.body.dataset.probeError || document.getElementById("json-hud")?.dataset.probeReady === "1"`,
      undefined,
      { timeout: 60_000 },
    );
    const failed = await page.evaluate<string>(
      `document.body.dataset.probeError ?? ""`,
    );
    if (failed) throw new Error(failed);
    const png = await waitForJsonUiPaintReady(page);
    writeFileSync("/tmp/vw-sidebar-full.png", png);

    const info = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll<HTMLElement>("[data-jsonui-name]"),
      ];
      const pick = (name: string) =>
        nodes
          .filter((n) => n.dataset.jsonuiName === name)
          .map((n) => {
            const r = n.getBoundingClientRect();
            const face = n.querySelector(".jsonui-image-face") as HTMLElement | null;
            return {
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
              z: getComputedStyle(n).zIndex,
              bg: (face?.style.backgroundImage || "").slice(0, 80),
              text: (n.innerText || "").slice(0, 40),
            };
          });
      return {
        main: pick("phud_sidebar.main"),
        dock: pick("phud_sidebar.dock"),
        ball: pick("phud_sidebar.ball_icon"),
        ring: pick("phud_sidebar.variable_parser").filter((n) =>
          n.bg.includes("ring"),
        ),
        plate: pick("phud_sidebar.variable_parser").filter((n) =>
          n.bg.includes("data"),
        ),
        emptyBalls: pick("phud_sidebar.ball_icon").filter((n) =>
          n.bg.includes("empty"),
        ).length,
        pokeBalls: pick("phud_sidebar.ball_icon").filter((n) =>
          n.bg.includes("poke"),
        ).length,
      };
    });
    console.log(JSON.stringify(info, null, 2));

    const full = PNG.sync.read(png);
    const main = info.main[0];
    if (!main) throw new Error("sidebar main missing");
    const clipX = Math.max(0, 1920 - 560);
    const clipY = Math.max(0, main.y - 16);
    const clipW = 1920 - clipX;
    const clipH = Math.min(1080 - clipY, main.h + 48);
    const crop = new PNG({ width: clipW, height: clipH });
    PNG.bitblt(full, crop, clipX, clipY, clipW, clipH, 0, 0);
    writeFileSync("/tmp/vw-sidebar-after2.png", PNG.sync.write(crop));
    console.log(
      `wrote /tmp/vw-sidebar-after2.png ${clipW}x${clipH} from y=${clipY}`,
    );
  } finally {
    await browser.close();
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
    });
    await vite.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
