/**
 * Replay a captured viewer SSE stream against the built app with a local pack
 * stack — offline, deterministic, inspectable in any browser.
 *
 * Serves on ONE origin (so the app's same-origin `/packs` + `/asset` fetches
 * work):
 *   /            the built app (viewer/dist — run `npm run build` first)
 *   /stream      the captured SSE file, replayed then held open
 *   /packs, /packs/index, /pack/<id>/…, /asset/…   local pack stack
 *
 * Usage:
 *   node tools/replay-server.mjs <capture.sse> [--port 8972]
 *
 * Env (same defaults as diagnose-terrain-packs.mjs):
 *   VANILLA_PACK  ../.cache/baseline/<baseline.tag>/resource_pack
 *   SERVER_PACK   pokebedrock-res development_resource_packs path (if present)
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const repoRoot = join(viewerRoot, "..");

const args = process.argv.slice(2);
const captureFile = args.find((a) => !a.startsWith("--"));
if (!captureFile || !existsSync(captureFile)) {
  console.error("usage: node tools/replay-server.mjs <capture.sse> [--port N]");
  process.exit(1);
}
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8972;

const distDir = join(viewerRoot, "dist");
if (!existsSync(join(distDir, "index.html"))) {
  console.error(`built app missing at ${distDir} — run \`npm run build\``);
  process.exit(1);
}

const baselineTag = readFileSync(join(viewerRoot, "baseline.tag"), "utf8").trim();
const defaultVanilla = join(
  repoRoot,
  ".cache",
  "baseline",
  baselineTag.startsWith("v") ? baselineTag : `v${baselineTag}`,
  "resource_pack",
);
const defaultServerCandidates = [
  join(
    process.env.APPDATA ?? "",
    "Minecraft Bedrock",
    "Users",
    "Shared",
    "games",
    "com.mojang",
    "development_resource_packs",
    "pokebedrock-res",
  ),
];
const vanillaDir = process.env.VANILLA_PACK || defaultVanilla;
const serverDir =
  process.env.SERVER_PACK ||
  defaultServerCandidates.find((p) => existsSync(join(p, "blocks.json")));

const packs = [];
if (existsSync(join(vanillaDir, "blocks.json"))) {
  packs.push({ id: "vanilla", priority: 0, name: "baseline", dir: vanillaDir });
} else {
  console.warn(`vanilla pack missing at ${vanillaDir}`);
}
if (serverDir && existsSync(join(serverDir, "blocks.json"))) {
  packs.push({
    id: "server-pack",
    priority: 1,
    name: "pokebedrock-res",
    dir: serverDir,
  });
}
console.log(
  "packs:",
  packs.map((p) => `${p.id}(${p.dir})`).join(", ") || "(none)",
);

/** @type {Map<string, { packId: string, abs: string }>} */
const index = new Map();
/** @type {Map<string, Map<string, string>>} */
const byPack = new Map();
for (const pack of packs) {
  const files = new Map();
  walkFiles(pack.dir, pack.dir, files);
  byPack.set(pack.id, files);
  for (const [rel, abs] of files) index.set(rel, { packId: pack.id, abs });
}

const captureBody = readFileSync(captureFile, "utf8");

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (url.pathname === "/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(captureBody);
    // Hold open; EventSource reconnect would replay from scratch.
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 10_000);
    req.on("close", () => clearInterval(beat));
    return;
  }
  if (url.pathname === "/packs") {
    json(
      res,
      packs.map((p, i) => ({
        id: p.id,
        uuid: `0000000${i}-0000-0000-0000-000000000000`,
        version: "1.0.0",
        name: p.name,
        priority: p.priority,
        fileCount: byPack.get(p.id)?.size ?? 0,
      })),
    );
    return;
  }
  if (url.pathname === "/packs/index") {
    /** @type {Record<string, string>} */
    const body = {};
    for (const [path, info] of index) body[path] = info.packId;
    json(res, body);
    return;
  }
  if (url.pathname.startsWith("/pack/")) {
    const rest = decodeURIComponent(url.pathname.slice("/pack/".length));
    const slash = rest.indexOf("/");
    if (slash < 0) return end(res, 404, "missing");
    const packId = rest.slice(0, slash);
    const rel = rest.slice(slash + 1).toLowerCase();
    if (rel.includes("..")) return end(res, 400, "bad path");
    const abs = byPack.get(packId)?.get(rel);
    if (!abs) return end(res, 404, "missing");
    return sendFile(res, abs);
  }
  if (url.pathname.startsWith("/asset/")) {
    const rel = decodeURIComponent(url.pathname.slice("/asset/".length)).toLowerCase();
    if (rel.includes("..")) return end(res, 400, "bad path");
    const hit = index.get(rel);
    if (!hit) return end(res, 404, "missing");
    return sendFile(res, hit.abs);
  }

  // Static app.
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  if (rel.includes("..")) return end(res, 400, "bad path");
  const abs = join(distDir, rel.slice(1));
  if (!existsSync(abs) || !statSync(abs).isFile()) return end(res, 404, "not found");
  sendFile(res, abs);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`replay: http://127.0.0.1:${port}/?camera=orbit  (stream: ${captureFile})`);
});

/**
 * @param {string} root
 * @param {string} dir
 * @param {Map<string, string>} out
 */
function walkFiles(root, dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(root, abs, out);
      continue;
    }
    const rel = relative(root, abs).split(sep).join("/").toLowerCase();
    if (!rel.includes("..")) out.set(rel, abs);
  }
}

/** @param {import('node:http').ServerResponse} res @param {unknown} body */
function json(res, body) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** @param {import('node:http').ServerResponse} res @param {number} code @param {string} msg */
function end(res, code, msg) {
  res.writeHead(code);
  res.end(msg);
}

const MIME = {
  ".json": "application/json",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".tga": "application/octet-stream",
};

/** @param {import('node:http').ServerResponse} res @param {string} abs */
function sendFile(res, abs) {
  const lower = abs.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf("."));
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
  });
  res.end(readFileSync(abs));
}
