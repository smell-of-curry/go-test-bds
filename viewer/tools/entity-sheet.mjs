/**
 * Contact sheet of Pokémon models under noon light, idle at t = 1.0 s.
 *
 * Packs: vanilla baseline resource_pack, then pokebedrock-res with
 * `subpacks/3d` overlaid (that subpack is the fancy-client 3D models; the
 * pack root is the 2D substitute). Writes /tmp/entity-sheet.png.
 *
 * `PACK_ROOTS` (colon-separated absolute dirs, later wins) replaces the
 * pokebedrock-res overlay. Use the film-cache extract in stack order
 * (core, ui, server, 3d) so the sheet matches what the server sent.
 * `SHEET_OUT` overrides the png path.
 *
 *   node tools/entity-sheet.mjs [pokemon:snorlax ...]
 */
import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createVite } from "vite";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const repoRoot = join(viewerRoot, "..");
const baseline = join(
  repoRoot,
  ".cache/baseline/v1.26.50.4/resource_pack",
);
const pbRoot = "/Users/eanlowell/GitHub/pokebedrock/pokebedrock-res";
const outPath = process.env.SHEET_OUT || "/tmp/entity-sheet.png";

const DEFAULT_IDS = [
  "pokemon:ditto",
  "pokemon:meowth",
  "pokemon:snorlax",
  "pokemon:porygon",
  "pokemon:blaziken",
  "pokemon:typhlosion",
  "pokemon:charizard",
  "pokemon:arcanine",
  "pokemon:squirtle",
  "pokemon:greninja",
  "pokemon:blastoise",
  "pokemon:gyarados",
  "pokemon:venusaur",
  "pokemon:sceptile",
  "pokemon:torterra",
  "pokemon:bulbasaur",
  "pokemon:pikachu",
  "pokemon:ampharos",
  "pokemon:zapdos",
  "pokemon:raichu",
  "pokemon:glaceon",
  "pokemon:abomasnow",
  "pokemon:lapras",
  "pokemon:ninetalesalola",
];

const ids = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_IDS;

if (!existsSync(baseline)) {
  console.error("missing baseline", baseline);
  process.exit(1);
}

/** @type {Map<string, string>} path → absolute file. Later writes win. */
const files = new Map();

/**
 * @param {string} root
 * @param {string} dir
 * @param {(rel: string) => boolean} [skip]
 */
function walk(root, dir, skip) {
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    const rel = relative(root, abs).split(sep).join("/").toLowerCase();
    if (skip?.(rel)) continue;
    if (st.isDirectory()) {
      walk(root, abs, skip);
      continue;
    }
    files.set(rel, abs);
  }
}

console.log("indexing packs…");
walk(baseline, baseline);
const before = files.size;
const packRoots = (process.env.PACK_ROOTS ?? "")
  .split(":")
  .map((s) => s.trim())
  .filter(Boolean);
if (packRoots.length) {
  for (const root of packRoots) {
    if (!existsSync(root)) {
      console.error("missing pack root", root);
      process.exit(1);
    }
    walk(root, root);
  }
} else {
  walk(pbRoot, pbRoot, (rel) => rel === "subpacks" || rel.startsWith("subpacks/"));
  const threeD = join(pbRoot, "subpacks/3d");
  walk(threeD, threeD);
}
console.log(
  `index ${files.size} files (vanilla ${before}, +${packRoots.length ? packRoots.length + " pack roots" : "pokebedrock"})`,
);

const MIME = {
  ".json": "application/json",
  ".png": "image/png",
  ".tga": "application/octet-stream",
  ".txt": "text/plain",
  ".lang": "text/plain",
};

const assetServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (url.pathname === "/packs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify([
        { id: "merged", priority: 1, name: "sheet", uuid: "0", version: "1.0.0", fileCount: files.size },
      ]),
    );
    return;
  }
  if (url.pathname === "/packs/index") {
    /** @type {Record<string, string>} */
    const body = {};
    for (const path of files.keys()) body[path] = "merged";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  if (url.pathname.startsWith("/asset/") || url.pathname.startsWith("/pack/")) {
    let rel = decodeURIComponent(
      url.pathname.startsWith("/asset/")
        ? url.pathname.slice("/asset/".length)
        : url.pathname.slice("/pack/".length).replace(/^[^/]+\//, ""),
    ).toLowerCase();
    if (rel.includes("..")) {
      res.writeHead(400);
      res.end("bad");
      return;
    }
    const abs = files.get(rel);
    if (!abs) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(readFileSync(abs));
    return;
  }
  res.writeHead(404);
  res.end("no");
});

await new Promise((resolve) => assetServer.listen(0, "127.0.0.1", resolve));
const assetPort = /** @type {import('node:net').AddressInfo} */ (assetServer.address()).port;
const assetBase = `http://127.0.0.1:${assetPort}`;
console.log("assets", assetBase);

const vite = await createVite({
  root: viewerRoot,
  configFile: join(viewerRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 5199, strictPort: false },
  logLevel: "error",
});
await vite.listen();
const appBase = vite.resolvedUrls?.local[0];
if (!appBase) throw new Error("no vite url");

const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180_000);
await page.goto(appBase, { waitUntil: "domcontentloaded" });

console.log("rendering", ids.length, "entities…");
const result = await page.evaluate(
  async ({ assetBase, ids }) => {
    const THREE = await import("/node_modules/three/build/three.module.js");
    const {
      EntityModelRegistry,
      applyBonePoses,
      applyEntityYaw,
      sampleAnimationPoses,
    } = await import("/src/entity/index.ts");
    const { AssetClient } = await import("/src/terrain/assetClient.ts");
    const { createDefaultHost } = await import("/src/molang/host.ts");

    const client = new AssetClient(assetBase);
    const registry = new EntityModelRegistry(client);
    await registry.load();

    const cols = 4;
    const cellW = 360;
    const cellH = 420;
    const rows = Math.ceil(ids.length / cols);
    const sheet = document.createElement("canvas");
    sheet.width = cols * cellW;
    sheet.height = rows * cellH;
    const sctx = sheet.getContext("2d");
    sctx.fillStyle = "#81b1fb";
    sctx.fillRect(0, 0, sheet.width, sheet.height);

    const notes = [];

    async function texOf(path) {
      const bmp = await client.fetchImage(path);
      if (!bmp) return null;
      const tex = new THREE.Texture(bmp);
      tex.flipY = false;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    }

    // grass_top.png is a grayscale mask; plains biome tint multiplies it.
    // grass_side.png is tga-only — carried side is the coloured PNG.
    const grassTop = await texOf("textures/blocks/grass_top");
    const grassSide = await texOf("textures/blocks/grass_side_carried");
    const dirt = await texOf("textures/blocks/dirt");
    const grassMats = [0, 1, 2, 3, 4, 5].map((face) => {
      const top = face === 2;
      const bottom = face === 3;
      const map = top ? grassTop : bottom ? dirt : grassSide;
      return new THREE.MeshBasicMaterial({
        map: map ?? undefined,
        color: top ? 0xb6e07a : 0xffffff,
      });
    });

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const label = id.replace("pokemon:", "");
      const ox = (i % cols) * cellW;
      const oy = Math.floor(i / cols) * cellH;
      try {
        const model = await registry.getModel({
          type: id,
          player: false,
          props: {},
          flags: { on_ground: true },
        });
        if (!model) {
          notes.push(`${id}: model null`);
          sctx.fillStyle = "#402030";
          sctx.fillRect(ox + 8, oy + 8, cellW - 16, cellH - 16);
          sctx.fillStyle = "#fff";
          sctx.font = "16px sans-serif";
          sctx.fillText(label + " MISSING", ox + 16, oy + 40);
          continue;
        }
        const bindings = registry.getAnimationBindings(id);
        const idleId = bindings?.shortNames?.default_ground_idle;
        const anim = idleId ? registry.getAnimation(idleId) : undefined;
        if (anim) {
          const poses = sampleAnimationPoses(anim, 1.0, createDefaultHost());
          applyBonePoses(model.bones, poses, 0);
        } else {
          notes.push(`${id}: no default_ground_idle`);
        }
        applyEntityYaw(model.root, 20);
        model.root.position.y = 1;
        model.root.updateMatrixWorld(true);
        // Geo origin is not always the feet. Sit the lowest vertex on the grass.
        const planted = new THREE.Box3().setFromObject(model.root);
        if (Number.isFinite(planted.min.y)) {
          model.root.position.y += 1 - planted.min.y;
          model.root.updateMatrixWorld(true);
        }

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x81b1fb);
        const grass = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), grassMats);
        grass.position.y = 0.5;
        scene.add(grass, model.root);

        const box = new THREE.Box3().setFromObject(model.root);
        if (box.isEmpty()) {
          box.set(new THREE.Vector3(-0.5, 1, -0.5), new THREE.Vector3(0.5, 2, 0.5));
        }
        const centre = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z, 0.8);
        const fovDeg = 36;
        const dist = (maxDim * 0.72) / Math.tan(((fovDeg * Math.PI) / 180) / 2);
        const yaw = 0.85;
        const pitch = 0.32;
        const camera = new THREE.PerspectiveCamera(
          fovDeg,
          cellW / (cellH - 28),
          0.05,
          Math.max(200, dist * 8),
        );
        camera.position.set(
          centre.x + dist * Math.cos(pitch) * Math.sin(yaw),
          centre.y + dist * Math.sin(pitch),
          centre.z + dist * Math.cos(pitch) * Math.cos(yaw),
        );
        camera.lookAt(centre);
        notes.push(
          `${id}: bones=${model.bones.size} size=${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)}`,
        );

        const renderer = new THREE.WebGLRenderer({
          antialias: false,
          preserveDrawingBuffer: true,
          alpha: false,
        });
        renderer.setSize(cellW, cellH - 28, false);
        renderer.render(scene, camera);
        sctx.drawImage(renderer.domElement, ox, oy);
        renderer.dispose();

        const bones = model.bones.size;
        notes.push(`${id}: bones=${bones} idle=${idleId ?? "none"}`);
      } catch (err) {
        notes.push(`${id}: ${err && err.message ? err.message : err}`);
        sctx.fillStyle = "#402030";
        sctx.fillRect(ox + 8, oy + 8, cellW - 16, cellH - 16);
      }
      sctx.fillStyle = "rgba(0,0,0,0.55)";
      sctx.fillRect(ox, oy + cellH - 28, cellW, 28);
      sctx.fillStyle = "#fff";
      sctx.font = "16px sans-serif";
      sctx.fillText(label, ox + 8, oy + cellH - 8);
    }

    return { png: sheet.toDataURL("image/png"), notes };
  },
  { assetBase, ids },
);

const b64 = result.png.replace(/^data:image\/png;base64,/, "");
writeFileSync(outPath, Buffer.from(b64, "base64"));
console.log("wrote", outPath);
for (const line of result.notes) console.log(line);

await browser.close();
await vite.close();
assetServer.close();
