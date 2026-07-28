/**
 * Diagnose terrain texture resolution against real resource packs.
 *
 * Serves vanilla (priority 0) + an optional server pack through the same
 * `/packs`, `/packs/index`, `/pack/<id>/…`, `/asset/…` routes the bot uses,
 * then runs `createTexturedMesher` and reports resolve vs `__missing__` counts.
 *
 * Defaults:
 *   VANILLA_PACK  ../.cache/baseline/<baseline.tag>/resource_pack
 *   SERVER_PACK   pokebedrock-res development_resource_packs path (if present)
 *
 * Skips (exit 0) when the vanilla pack is missing — CI without the cache stays green.
 *
 * Usage:
 *   node tools/diagnose-terrain-packs.mjs
 *   VANILLA_PACK=… SERVER_PACK=… node tools/diagnose-terrain-packs.mjs
 *   REGISTRIES_JSON=testdata/registries-fixture.json node tools/diagnose-terrain-packs.mjs
 *
 * Palette coverage (stage 8): loads REGISTRIES_JSON or testdata/registries-fixture.json
 * and reports material_instances / atlas-resolve / neutral-fallback counts.
 */
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const repoRoot = join(viewerRoot, "..");

const baselineTag = readFileSync(join(viewerRoot, "baseline.tag"), "utf8")
  .trim()
  .replace(/^v/, "v"); // keep leading v
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
  join(
    process.env.LOCALAPPDATA ?? "",
    "Minecraft Bedrock",
    "Users",
    "Shared",
    "games",
    "com.mojang",
    "development_resource_packs",
    "pokebedrock-res",
  ),
];
const defaultServer =
  defaultServerCandidates.find((p) => existsSync(join(p, "blocks.json"))) ??
  defaultServerCandidates[0];

const vanillaDir = process.env.VANILLA_PACK || defaultVanilla;
const serverDir = process.env.SERVER_PACK || defaultServer;
const outDir = process.env.DIAG_OUT || join(viewerRoot, "testdata", "diagnose");

if (!existsSync(join(vanillaDir, "blocks.json"))) {
  console.log(
    JSON.stringify({
      skipped: true,
      reason: "vanilla pack missing",
      lookedFor: join(vanillaDir, "blocks.json"),
      hint: "Download Mojang/bedrock-samples at viewer/baseline.tag into .cache/baseline/<tag>/",
    }),
  );
  process.exit(0);
}

const packs = [
  { id: "vanilla", priority: 0, name: "baseline", dir: vanillaDir },
];
if (existsSync(join(serverDir, "blocks.json"))) {
  packs.push({
    id: "server-pack",
    priority: 1,
    name: "pokebedrock-res",
    dir: serverDir,
  });
} else {
  console.warn(`server pack missing at ${serverDir}; diagnosing vanilla only`);
}

/** @type {Map<string, { packId: string, abs: string }>} */
const index = new Map();
/** @type {Map<string, Map<string, string>>} */
const byPack = new Map();

for (const pack of packs) {
  const files = new Map();
  walkFiles(pack.dir, pack.dir, files);
  byPack.set(pack.id, files);
  for (const [rel, abs] of files) {
    index.set(rel, { packId: pack.id, abs });
  }
}

const assetServer = await listenPackServer(packs, byPack, index);
let vite;
let browser;
try {
  vite = await createViteServer({
    root: viewerRoot,
    configFile: join(viewerRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 5199, strictPort: false },
  });
  await vite.listen();
  const viteUrl = vite.resolvedUrls?.local[0];
  if (!viteUrl) throw new Error("no vite url");

  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(viteUrl, { waitUntil: "domcontentloaded" });

  const registriesPath =
    process.env.REGISTRIES_JSON ||
    join(viewerRoot, "testdata", "registries-fixture.json");
  /** @type {unknown} */
  let registriesJson = null;
  if (existsSync(registriesPath)) {
    registriesJson = JSON.parse(readFileSync(registriesPath, "utf8"));
  }

  const result = await page.evaluate(
    async ({ assetBase, registries }) => {
      const {
        createTexturedMesher,
        FALLBACK_TEXTURE,
        NEUTRAL_TEXTURE,
        expandTexturesField,
        paletteCoverageAgainstAtlas,
      } = await import("/src/terrain/index.ts");

      const bundle = await createTexturedMesher({
        baseUrl: assetBase,
        registries,
      });
      const atlas = bundle.atlas;
      const resolver = bundle.resolver;

      // Re-fetch merged blocks the same way createTexturedMesher did.
      const packsRes = await fetch(`${assetBase}/packs`).then((r) => r.json());
      const layers = [];
      for (const p of packsRes) {
        const res = await fetch(
          `${assetBase}/pack/${encodeURIComponent(p.id)}/blocks.json`,
        );
        if (res.ok) layers.push(await res.json());
      }
      const { mergeBlocksLayers } = await import("/src/terrain/index.ts");
      const merged = mergeBlocksLayers(layers);

      const fbUv = atlas.uvRect(FALLBACK_TEXTURE, 0);
      /** @type {Array<{ id: string, reason: string, detail?: string }>} */
      const failures = [];
      let ok = 0;
      let fail = 0;
      let noTextures = 0;

      for (const [id, def] of Object.entries(merged)) {
        const faces = expandTexturesField(def?.textures);
        const shorts = [
          ...new Set(
            Object.values(faces).filter((s) => typeof s === "string" && s),
          ),
        ];
        if (shorts.length === 0) {
          noTextures++;
          // sound-only is fine for pokeb custom blocks without models yet —
          // still count as "no atlas tile from textures field"
          if (failures.length < 10) {
            failures.push({
              id,
              reason: "no_textures_field",
              detail: Object.keys(def ?? {}).join(","),
            });
          }
          fail++;
          continue;
        }

        /** @type {string[]} */
        const reasons = [];
        for (const short of shorts) {
          if (!atlas.has(short)) {
            const entry = atlas.terrainEntry?.(short);
            if (!entry || entry.paths.length === 0) {
              reasons.push(`short_name_absent_or_unpacked:${short}`);
            } else {
              reasons.push(`atlas_pack_miss:${short}->${entry.paths[0]?.path}`);
            }
          } else {
            const uv = atlas.uvFor(short, 0, 0, 0, 0);
            if (
              uv.u0 === fbUv.u0 &&
              uv.v0 === fbUv.v0 &&
              short !== FALLBACK_TEXTURE
            ) {
              reasons.push(`uv_is_fallback:${short}`);
            }
          }
        }

        // World snapshots use namespaced ids; bare blocks.json keys must still resolve.
        const worldId = id.includes(":") ? id : `minecraft:${id}`;
        const cube = resolver.resolveCube(
          { name: worldId, states: {}, rid: 1 },
          0,
          0,
          0,
        );
        if (cube) {
          const faceTex = cube.faces.up?.texture;
          if (faceTex === FALLBACK_TEXTURE) {
            reasons.push(`resolveCube_fallback_for_world_id:${worldId}`);
          } else if (faceTex !== NEUTRAL_TEXTURE && !atlas.has(faceTex)) {
            reasons.push(`resolveCube_texture_unpacked:${faceTex}`);
          }
        }

        if (reasons.length) {
          fail++;
          if (failures.length < 10) {
            failures.push({
              id,
              reason: reasons[0],
              detail: reasons.join(" | "),
            });
          }
        } else {
          ok++;
        }
      }

      const palette = registries
        ? paletteCoverageAgainstAtlas(registries, atlas)
        : null;

      // Atlas dump via canvas → data URL
      const src = atlas.imageSource();
      const dump = new OffscreenCanvas(src.width, src.height);
      const ctx = dump.getContext("2d");
      ctx.drawImage(src, 0, 0);
      // Sample a few pixels for emptiness / single-colour check.
      const sample = ctx.getImageData(
        0,
        0,
        Math.min(64, src.width),
        Math.min(64, src.height),
      ).data;
      let nonZero = 0;
      let magenta = 0;
      for (let i = 0; i < sample.length; i += 4) {
        const r = sample[i],
          g = sample[i + 1],
          b = sample[i + 2],
          a = sample[i + 3];
        if (a > 0 && (r > 8 || g > 8 || b > 8)) nonZero++;
        if (r > 200 && g < 40 && b > 200) magenta++;
      }
      const blob = await dump.convertToBlob({ type: "image/png" });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
      const atlasPngBase64 = btoa(binary);

      bundle.mesher.dispose();
      return {
        packCount: packsRes.length,
        blockCount: Object.keys(merged).length,
        ok,
        fail,
        noTextures,
        failures,
        palette: palette
          ? {
              entryCount: palette.entryCount,
              withMaterialInstances: palette.withMaterialInstances,
              texturesResolved: palette.texturesResolved,
              neutralNoMaterials: palette.neutralNoMaterials,
              atlasMiss: palette.atlasMiss,
              withGeometry: palette.withGeometry,
              sample: palette.entries.slice(0, 10).map((e) => ({
                name: e.name,
                hasMaterialInstances: e.hasMaterialInstances,
                texturesResolved: e.texturesResolved,
                reason: e.reason,
                detail: e.detail,
                textureShortNames: e.textureShortNames,
              })),
            }
          : { skipped: true, reason: "no REGISTRIES_JSON / fixture" },
        atlas: {
          width: src.width,
          height: src.height,
          packedTiles: atlas.has("flattened_stone") || atlas.has("stone"),
          hasFlattenedStone: atlas.has("flattened_stone"),
          hasNeutral: atlas.has(NEUTRAL_TEXTURE),
          sampleNonZeroTexels: nonZero,
          sampleMagentaTexels: magenta,
          pngBase64: atlasPngBase64,
        },
        sampleKeys: Object.keys(merged).slice(0, 5),
        hasMinecraftStoneKey: Object.prototype.hasOwnProperty.call(
          merged,
          "minecraft:stone",
        ),
        hasBareStoneKey: Object.prototype.hasOwnProperty.call(merged, "stone"),
      };
    },
    { assetBase: assetServer.url, registries: registriesJson },
  );

  mkdirSync(outDir, { recursive: true });
  const pngPath = join(outDir, "atlas.png");
  writeFileSync(
    pngPath,
    Buffer.from(result.atlas.pngBase64, "base64"),
  );
  const report = {
    ...result,
    atlas: {
      ...result.atlas,
      pngBase64: undefined,
      pngPath,
    },
    vanillaDir,
    serverDir: packs.length > 1 ? serverDir : null,
    indexSize: index.size,
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
  await vite?.close().catch(() => undefined);
  await assetServer.close();
}

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
    if (rel.includes("..")) continue;
    out.set(rel, abs);
  }
}

/**
 * @param {Array<{id:string,priority:number,name:string,dir:string}>} packs
 * @param {Map<string, Map<string, string>>} byPack
 * @param {Map<string, { packId: string, abs: string }>} index
 */
function listenPackServer(packs, byPack, index) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (url.pathname === "/packs") {
      json(
        res,
        packs.map((p) => ({
          id: p.id,
          uuid:
            p.id === "vanilla"
              ? "00000000-0000-0000-0000-000000000000"
              : "11111111-1111-1111-1111-111111111111",
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
      if (slash < 0) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      const packId = rest.slice(0, slash);
      const rel = rest.slice(slash + 1).toLowerCase();
      if (rel.includes("..")) {
        res.writeHead(400);
        res.end("bad path");
        return;
      }
      const abs = byPack.get(packId)?.get(rel);
      if (!abs) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      sendFile(res, abs);
      return;
    }
    if (url.pathname.startsWith("/asset/")) {
      const rel = decodeURIComponent(url.pathname.slice("/asset/".length)).toLowerCase();
      if (rel.includes("..")) {
        res.writeHead(400);
        res.end("bad path");
        return;
      }
      const hit = index.get(rel);
      if (!hit) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      sendFile(res, hit.abs);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no bind"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

/** @param {import('node:http').ServerResponse} res @param {unknown} body */
function json(res, body) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** @param {import('node:http').ServerResponse} res @param {string} abs */
function sendFile(res, abs) {
  const buf = readFileSync(abs);
  const lower = abs.toLowerCase();
  const ct = lower.endsWith(".json")
    ? "application/json"
    : lower.endsWith(".png")
      ? "image/png"
      : "application/octet-stream";
  res.writeHead(200, { "Content-Type": ct });
  res.end(buf);
}
