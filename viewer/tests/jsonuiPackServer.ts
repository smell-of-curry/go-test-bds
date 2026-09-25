/**
 * Serve testdata/jsonui packs over the hub-shaped pack HTTP API:
 * GET /packs, /pack/{id}/{path}, /asset/{path}.
 *
 * Fixture files live under `testdata/jsonui/<packId>/…` without the `ui/`
 * prefix that Bedrock pack paths use. Texture bytes prefer the live pack
 * extract, then the cached vanilla baseline (nineslice JSON + chrome PNGs).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBaseline } from "./ensureBaseline";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const repoRoot = join(viewerRoot, "..");
const fixturesRoot = join(viewerRoot, "testdata", "jsonui");
const liveExtract = join(fixturesRoot, "live-v2.18.5", "_extract");

let baselineFetched = false;

/**
 * Absolute path to the pinned bedrock-samples resource_pack.
 *
 * Reads `viewer/baseline.tag` (and optionally `GOLDEN_BASELINE_DIR`) so a pin
 * bump does not leave this helper stuck on a stale hardcoded tag.
 *
 * @returns resource_pack directory, which may not exist yet.
 */
function baselineResourcePack(): string {
  const fromEnv = process.env.GOLDEN_BASELINE_DIR?.trim();
  if (fromEnv) return join(fromEnv, "resource_pack");
  const raw = readFileSync(join(viewerRoot, "baseline.tag"), "utf8").trim();
  const pinned = raw.startsWith("v") ? raw : `v${raw}`;
  return join(repoRoot, ".cache", "baseline", pinned, "resource_pack");
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
} as const;

/**
 * @param pathname - URL pathname.
 * @returns true when this helper should handle the request.
 */
export function isJsonUiPackPath(pathname: string): boolean {
  return (
    pathname === "/packs" ||
    pathname.startsWith("/pack/") ||
    pathname.startsWith("/asset/")
  );
}

/**
 * Resolve a pack-relative asset path to a file on disk.
 *
 * @param rel - Path like `textures/ui/control.png`.
 * @returns absolute path, or null.
 */
function resolveAssetFile(rel: string): string | null {
  if (!baselineFetched) {
    ensureBaseline();
    baselineFetched = true;
  }
  const candidates = [
    join(liveExtract, rel),
    join(baselineResourcePack(), rel),
  ];
  for (const abs of candidates) {
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
  }
  return null;
}

/**
 * Handle a pack / asset request against testdata/jsonui.
 *
 * @param req - Incoming request.
 * @param res - Response to write.
 * @returns true when handled.
 */
export function handleJsonUiPackRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!isJsonUiPackPath(url.pathname)) return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return true;
  }

  if (url.pathname === "/packs") {
    res.writeHead(200, { ...CORS, "content-type": "application/json" });
    const packs: { id: string; priority: number }[] = [
      { id: "vanilla", priority: 0 },
    ];
    if (existsSync(join(fixturesRoot, "addon"))) {
      packs.push({ id: "addon", priority: 1 });
    }
    res.end(JSON.stringify(packs));
    return true;
  }

  const packMatch = /^\/pack\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (packMatch) {
    const packId = decodeURIComponent(packMatch[1]!);
    let rel = decodeURIComponent(packMatch[2]!);
    if (rel.toLowerCase().startsWith("ui/")) rel = rel.slice(3);
    const abs = join(fixturesRoot, packId, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      res.writeHead(404, CORS);
      res.end("missing");
      return true;
    }
    const isLang = /\.lang$/i.test(abs);
    res.writeHead(200, {
      ...CORS,
      "content-type": isLang ? "text/plain; charset=utf-8" : "application/json",
    });
    res.end(readFileSync(abs));
    return true;
  }

  if (url.pathname.startsWith("/asset/")) {
    const rel = decodeURIComponent(url.pathname.slice("/asset/".length));
    const abs = resolveAssetFile(rel);
    if (!abs) {
      res.writeHead(404, CORS);
      res.end("no asset");
      return true;
    }
    const isJson = /\.json$/i.test(abs);
    const isPng = /\.png$/i.test(abs);
    res.writeHead(200, {
      ...CORS,
      "content-type": isJson
        ? "application/json"
        : isPng
          ? "image/png"
          : "application/octet-stream",
    });
    res.end(readFileSync(abs));
    return true;
  }

  return false;
}
