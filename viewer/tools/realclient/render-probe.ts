/**
 * Render probe.root with the viewer's JSON UI engine.
 *
 *   cd viewer && npx tsx tools/realclient/render-probe.ts \
 *     --width 1920 --height 1080 --gui-scale 2 --out /tmp/probe-viewer.png
 *
 * Pack stack (later wins): real-client vanilla, pokebedrock-res, probe pack.
 * Vanilla UI JSON lives in `__brarchive/ui.brarchive` on 1.26.51; loose files
 * are preferred when present.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";
import { waitForJsonUiPaintReady } from "../../tests/jsonUiPaintReady";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = resolve(here, "../..");

const VANILLA =
  "/Users/eanlowell/Library/Application Support/mcpelauncher/versions/1.26.51.1/assets/assets/resource_packs/vanilla";
const RES = "/Users/eanlowell/GitHub/pokebedrock/pokebedrock-res";
const PROBE = join(here, "probe-pack");
const FONT_DIR =
  process.env.GOTESTBDS_VIEWER_FONT_DIR ??
  "/Users/eanlowell/Library/Application Support/mcpelauncher/versions/1.26.51.1/assets/assets/fonts";
const FONT = join(FONT_DIR, "Mojangles.ttf");

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
  { id: "probe", priority: 2, root: PROBE },
];

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v || v.startsWith("--")) return fallback;
  return v;
}

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

/** Filename → raw bytes from a Bedrock `ui.brarchive` (uncompressed members). */
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
  return "application/octet-stream";
}

function send(res: ServerResponse, status: number, body: Buffer | string, type?: string): void {
  res.writeHead(status, {
    ...CORS,
    ...(type ? { "content-type": type } : {}),
  });
  res.end(body);
}

/** `font/glyph_XX.png` → winning pack id. Later packs overwrite. */
function glyphIndex(): Record<string, string> {
  const ordered = PACKS.slice().sort((a, b) => a.priority - b.priority);
  const out: Record<string, string> = {};
  for (const pack of ordered) {
    const dir = join(pack.root, "font");
    if (!existsSync(dir)) continue;
    let names: string[];
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

function handlePack(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
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

async function main(): Promise<void> {
  const width = Number(arg("width", "1920"));
  const height = Number(arg("height", "1080"));
  const guiScale = Number(arg("gui-scale", "2"));
  const out = resolve(arg("out", "/tmp/probe-viewer.png"));
  if (![width, height, guiScale].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error("width, height, and gui-scale must be positive numbers");
  }
  for (const pack of PACKS) {
    if (!existsSync(pack.root)) throw new Error(`missing pack root ${pack.root}`);
  }

  const vite = await createViteServer({
    root: viewerRoot,
    configFile: join(viewerRoot, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "custom",
  });

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/tools/realclient/probe-page.html") {
      send(
        res,
        200,
        readFileSync(join(here, "probe-page.html")),
        "text/html; charset=utf-8",
      );
      return;
    }
    if (
      url.pathname === "/packs" ||
      url.pathname.startsWith("/pack/") ||
      url.pathname.startsWith("/asset/") ||
      url.pathname === "/packs/index" ||
      url.pathname === "/font/Mojangles.ttf"
    ) {
      if (handlePack(req, res, url.pathname)) return;
    }
    vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no bind address");
  const origin = `http://127.0.0.1:${addr.port}`;
  const pageUrl =
    `${origin}/tools/realclient/probe-page.html` +
    `?guiScale=${guiScale}&width=${width}&height=${height}`;

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
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    // tsx `keepNames` injects `__name()` into functions Playwright serializes
    // into the page. Define the helper before any evaluate.
    await page.addInitScript(`globalThis.__name = (fn) => fn;`);
    page.on("pageerror", (err) => {
      console.error(`[pageerror] ${err.message}`);
    });
    page.on("response", (resp) => {
      if (resp.status() < 400) return;
      const url = resp.url();
      if (url.includes("/pack/") || url.includes("/asset/") || url.includes("/font/")) return;
      console.error(`[http ${resp.status()}] ${url}`);
    });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
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
    writeFileSync(out, png);
    console.log(`wrote ${out} ${width}x${height} guiScale=${guiScale}`);
  } finally {
    await browser.close();
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
    });
    await vite.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
