/**
 * One origin for an offline film render: the viewer app, the take SSE, skins,
 * and the resource-pack stack.
 *
 * Pack order (first that can answer):
 *   1. take.json `cacheDir` + `baselineTag` — Go's layout
 *      `<cache>/packs/<uuid>/<version>/` plus
 *      `<repo>/.cache/baseline/<tag>/resource_pack`. Subpacks follow the
 *      viewer's tier-5 rule (highest memory tier ≤ 5).
 *   2. `<take>/packs-mirror/` written by `--packs-from` (request paths).
 *   3. `--packs-from <hub>` fills the mirror on demand, then serves it.
 *
 * Without any of those, `/packs` is 404 and the app falls back to placeholder
 * cubes (fine for the golden fixture).
 *
 * `GET /film/sse?bot=` returns `<take>/<bot>.sse` (or `.jsonl`) as a finite
 * body. Film mode fetches that; it does not use EventSource.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const repoRoot = join(viewerRoot, "..");

const MIME = {
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".tga": "image/x-tga",
  ".lang": "text/plain; charset=utf-8",
  ".ogg": "audio/ogg",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * @param {object} opts
 * @param {string} opts.takeDir
 * @param {number} [opts.port]
 * @param {boolean} [opts.dev]
 * @param {string} [opts.appDir]
 * @param {string} [opts.packsFrom] live hub origin, no trailing slash
 * @param {number} [opts.memoryTier]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startFilmServer(opts) {
  const takeDir = opts.takeDir;
  const memoryTier = opts.memoryTier ?? 5;
  const packsFrom = opts.packsFrom ? opts.packsFrom.replace(/\/$/, "") : "";
  const mirrorDir = join(takeDir, "packs-mirror");
  const stack = loadStack(takeDir, memoryTier);
  const dev = opts.dev
    ? await (
        await import("vite")
      ).createServer({
        root: viewerRoot,
        configFile: join(viewerRoot, "vite.config.ts"),
        server: { middlewareMode: true },
        appType: "spa",
        logLevel: "error",
      })
    : null;
  const appDir = opts.appDir ?? join(viewerRoot, "dist");
  if (!dev && !existsSync(join(appDir, "index.html"))) {
    throw new Error(
      `viewer app missing at ${appDir} — run \`npm run build\` in viewer/ or pass --dev`,
    );
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) end(res, 500, String(err));
    });
  });

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = decodeURIComponent(url.pathname);
    if (path.includes("..")) return end(res, 400, "bad path");

    if (path === "/film/sse") {
      const bot = url.searchParams.get("bot") ?? "";
      const body = readTakeSse(takeDir, bot);
      if (body == null) return end(res, 404, `no SSE for bot ${bot}`);
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    if (path === "/packs") {
      if (stack) return json(res, stack.list);
      if (await mirrorSend(res, "/packs")) return;
      return end(res, 404, "no packs");
    }
    if (path === "/packs/index") {
      if (stack) return json(res, stack.index);
      if (await mirrorSend(res, "/packs/index")) return;
      return end(res, 404, "no packs");
    }
    if (path.startsWith("/pack/")) {
      const rest = path.slice("/pack/".length);
      const slash = rest.indexOf("/");
      if (slash < 0) return end(res, 404, "missing");
      const packId = rest.slice(0, slash);
      const rel = rest.slice(slash + 1).toLowerCase();
      const abs = stack?.byPack.get(packId)?.get(rel);
      if (abs) return sendFile(res, abs);
      if (await mirrorSend(res, path)) return;
      return end(res, 404, "missing");
    }
    if (path.startsWith("/asset/")) {
      const rel = path.slice("/asset/".length).toLowerCase();
      const hit = stack?.files.get(rel);
      if (hit) return sendFile(res, hit);
      if (await mirrorSend(res, path)) return;
      return end(res, 404, "missing");
    }
    if (path.startsWith("/skin/")) {
      const name = path.slice("/skin/".length);
      const abs = join(takeDir, "skins", name);
      if (existsSync(abs) && statSync(abs).isFile()) return sendFile(res, abs);
      return end(res, 404, "missing skin");
    }
    if (dev) {
      dev.middlewares(req, res, () => end(res, 404, "not found"));
      return;
    }
    let rel = path;
    if (rel === "/") rel = "/index.html";
    const abs = join(appDir, rel.slice(1));
    if (!existsSync(abs) || !statSync(abs).isFile()) return end(res, 404, "not found");
    sendFile(res, abs);
  }

  /**
   * Serve a previously mirrored response, or fetch it from `--packs-from`.
   *
   * @param {import('node:http').ServerResponse} res
   * @param {string} reqPath
   * @returns {Promise<boolean>} true when the response was written
   */
  async function mirrorSend(res, reqPath) {
    const local = join(mirrorDir, reqPath);
    if (existsSync(local) && statSync(local).isFile()) {
      sendFile(res, local);
      return true;
    }
    if (!packsFrom) return false;
    const upstream = await fetch(`${packsFrom}${reqPath}`);
    if (!upstream.ok) return false;
    const buf = Buffer.from(await upstream.arrayBuffer());
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, buf);
    const type = upstream.headers.get("content-type") ?? contentType(local);
    res.writeHead(200, { "Content-Type": type });
    res.end(buf);
    return true;
  }

  await new Promise((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("film server has no port");
  const url = `http://127.0.0.1:${addr.port}`;
  console.error(
    `film server ${url} packs=${stack ? stack.list.map((p) => p.id).join(",") || "none" : packsFrom || "none"}`,
  );
  return {
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        void dev?.close();
      }),
  };
}

/**
 * @param {string} takeDir
 * @param {string} bot
 * @returns {string | null}
 */
function readTakeSse(takeDir, bot) {
  const sse = join(takeDir, `${bot}.sse`);
  const jsonl = join(takeDir, `${bot}.jsonl`);
  const file = existsSync(sse) ? sse : existsSync(jsonl) ? jsonl : "";
  if (!file) return null;
  const text = readFileSync(file, "utf8");
  const trimmed = text.trimStart();
  if (
    trimmed.startsWith("event:") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith(":")
  ) {
    return text;
  }
  const frames = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
  return frames
    .map((f) => `event: ${f.type ?? "message"}\ndata: ${JSON.stringify(f)}\n\n`)
    .join("");
}

/**
 * @param {string} takeDir
 * @param {number} memoryTier
 * @returns {null | { list: object[], index: Record<string, string>, files: Map<string, string>, byPack: Map<string, Map<string, string>> }}
 */
function loadStack(takeDir, memoryTier) {
  const takePath = join(takeDir, "take.json");
  const take = existsSync(takePath)
    ? JSON.parse(readFileSync(takePath, "utf8"))
    : {};
  const tag = typeof take.baselineTag === "string" ? take.baselineTag : "";
  const vanilla = tag ? vanillaDir(tag) : "";
  const cacheDir =
    typeof take.cacheDir === "string" && existsSync(take.cacheDir) ? take.cacheDir : "";
  /** @type {{ id: string, uuid: string, version: string, name: string, priority: number, dir: string }[]} */
  const packs = [];
  if (
    vanilla &&
    (existsSync(join(vanilla, "manifest.json")) || existsSync(join(vanilla, "blocks.json")))
  ) {
    packs.push({
      id: "vanilla",
      uuid: "vanilla",
      version: tag,
      name: "vanilla",
      priority: 0,
      dir: vanilla,
    });
  }
  const describedPath = join(takeDir, "packs.json");
  const described = existsSync(describedPath)
    ? JSON.parse(readFileSync(describedPath, "utf8"))
    : null;
  if (Array.isArray(described) && cacheDir) {
    for (const entry of described) {
      if (!entry || entry.id === "vanilla") continue;
      const uuid = String(entry.uuid ?? entry.id ?? "").toLowerCase();
      const version = sanitizeVersion(String(entry.version ?? ""));
      const dir = join(cacheDir, "packs", uuid, version);
      if (!existsSync(join(dir, "manifest.json"))) continue;
      packs.push({
        id: String(entry.id ?? uuid),
        uuid,
        version: String(entry.version ?? version),
        name: String(entry.name ?? uuid),
        priority: Number(entry.priority ?? packs.length),
        dir,
      });
    }
  } else if (cacheDir) {
    const root = join(cacheDir, "packs");
    if (existsSync(root)) {
      for (const uuid of readdirSync(root)) {
        const uuidDir = join(root, uuid);
        if (!statSync(uuidDir).isDirectory()) continue;
        for (const version of readdirSync(uuidDir)) {
          const dir = join(uuidDir, version);
          if (!existsSync(join(dir, "manifest.json"))) continue;
          packs.push({
            id: uuid,
            uuid,
            version,
            name: uuid,
            priority: packs.length,
            dir,
          });
        }
      }
    }
  }
  if (packs.length === 0) return null;
  packs.sort((a, b) => a.priority - b.priority);
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {Map<string, Map<string, string>>} */
  const byPack = new Map();
  /** @type {Record<string, string>} */
  const index = {};
  const list = [];
  for (const pack of packs) {
    const map = indexPack(pack.dir, memoryTier);
    byPack.set(pack.id, map);
    for (const [rel, abs] of map) {
      files.set(rel, abs);
      index[rel] = pack.id;
    }
    list.push({
      id: pack.id,
      uuid: pack.uuid,
      version: pack.version,
      name: pack.name,
      priority: pack.priority,
      fileCount: map.size,
    });
  }
  return { list, index, files, byPack };
}

/**
 * @param {string} dir
 * @param {number} memoryTier
 * @returns {Map<string, string>}
 */
function indexPack(dir, memoryTier) {
  const files = indexTree(dir, true);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return files;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return files;
  }
  const sub = selectSubpack(manifest, memoryTier);
  if (!sub) return files;
  const base = join(dir, "subpacks", sub);
  if (!existsSync(base)) return files;
  for (const [rel, abs] of indexTree(base, false)) files.set(rel, abs);
  return files;
}

/**
 * Highest memory tier at or below the device tier. Last tie wins.
 * Matches gotestbds/assets Manifest.SelectSubpack.
 *
 * @param {object} manifest
 * @param {number} deviceTier
 * @returns {string}
 */
function selectSubpack(manifest, deviceTier) {
  const subs = Array.isArray(manifest?.subpacks) ? manifest.subpacks : [];
  let bestTier = -1;
  let best = "";
  for (const sp of subs) {
    let tier = sp.memory_performance_tier;
    if (!(tier > 0)) tier = sp.memory_tier || 0;
    if (tier > deviceTier) continue;
    if (tier >= bestTier) {
      bestTier = tier;
      best = sp.folder_name || "";
    }
  }
  return best;
}

/**
 * @param {string} root
 * @param {boolean} skipSubpacks
 * @returns {Map<string, string>}
 */
function indexTree(root, skipSubpacks) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (skipSubpacks && dir === root && name === "subpacks") continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      const rel = relative(root, abs).split(sep).join("/").toLowerCase();
      if (!rel.includes("..")) out.set(rel, abs);
    }
  };
  walk(root);
  return out;
}

/**
 * @param {string} tag
 * @returns {string}
 */
function vanillaDir(tag) {
  const t = tag.startsWith("v") ? tag : `v${tag}`;
  return join(repoRoot, ".cache", "baseline", t, "resource_pack");
}

/**
 * @param {string} version
 * @returns {string}
 */
function sanitizeVersion(version) {
  const v = version.trim().replaceAll("/", "_").replaceAll("\\", "_");
  return v || "0.0.0";
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} body
 */
function json(res, body) {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} code
 * @param {string} msg
 */
function end(res, code, msg) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(msg);
}

/**
 * @param {string} abs
 * @returns {string}
 */
function contentType(abs) {
  const lower = abs.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf("."));
  return MIME[ext] ?? "application/octet-stream";
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} abs
 */
function sendFile(res, abs) {
  res.writeHead(200, { "Content-Type": contentType(abs), "Cache-Control": "no-store" });
  res.end(readFileSync(abs));
}
