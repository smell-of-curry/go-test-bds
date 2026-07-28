import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { deflateSync } from "node:zlib";

export interface TerrainFixturePack {
  /** Pack-relative path → raw bytes. */
  files: Map<string, Uint8Array>;
}

export interface TerrainAssetServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Minimal RGBA PNG encoder (no dependencies). Enough for tiny fixture tiles.
 *
 * @param width - Width.
 * @param height - Height.
 * @param rgba - length width*height*4.
 * @returns PNG bytes.
 */
export function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array {
  const stride = width * 4;
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = deflateSync(raw);

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crcBuf = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Solid-colour tile.
 *
 * @param w - Width.
 * @param h - Height.
 * @param r - Red 0..255.
 * @param g - Green.
 * @param b - Blue.
 * @param a - Alpha.
 * @returns PNG bytes.
 */
export function solidPng(
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): Uint8Array {
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return encodePng(w, h, rgba);
}

/**
 * 16×16 tile: left half colour A, right half colour B (for tiling pixel tests).
 *
 * @param size - Edge length.
 * @param left - RGB for x < size/2.
 * @param right - RGB for x >= size/2.
 * @returns PNG bytes.
 */
export function stripePng(
  size: number,
  left: [number, number, number],
  right: [number, number, number],
): Uint8Array {
  const rgba = Buffer.alloc(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = x < half ? left : right;
      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

/**
 * Vertical flipbook strip: N square frames stacked.
 *
 * @param size - Frame edge.
 * @param frames - Per-frame RGB.
 * @returns PNG bytes.
 */
export function flipbookPng(
  size: number,
  frames: Array<[number, number, number]>,
): Uint8Array {
  const h = size * frames.length;
  const rgba = Buffer.alloc(size * h * 4);
  for (let f = 0; f < frames.length; f++) {
    const [r, g, b] = frames[f]!;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = ((f * size + y) * size + x) * 4;
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = 255;
      }
    }
  }
  return encodePng(size, h, rgba);
}

/**
 * Build the hand-authored fixture pack used by terrain tests.
 *
 * @returns file map.
 */
export function buildFixturePack(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const json = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
  const set = (path: string, data: Uint8Array) => {
    files.set(path.toLowerCase(), data);
  };

  set(
    "blocks.json",
    json({
      format_version: ["1", "1", "0"],
      "minecraft:stone": { textures: "stone" },
      "minecraft:glass": { textures: "glass" },
      "minecraft:oak_leaves": { textures: "leaves_oak" },
      "minecraft:grass_block": {
        textures: { up: "grass_top", down: "dirt", side: "grass_side" },
      },
      "minecraft:test_directional": {
        textures: {
          north: "furnace_front",
          south: "furnace_side",
          east: "furnace_side",
          west: "furnace_side",
          up: "furnace_top",
          down: "furnace_top",
        },
      },
      "minecraft:test_varied": { textures: "varied_stone" },
      "minecraft:water": { textures: "water_still" },
      "minecraft:flowing_water": { textures: "water_flow" },
      "minecraft:oak_log": {
        textures: { up: "log_oak_top", down: "log_oak_top", side: "log_oak" },
      },
      "minecraft:test_stripe": { textures: "stripe" },
    }),
  );

  set(
    "textures/terrain_texture.json",
    json({
      resource_pack_name: "fixture",
      texture_name: "atlas.terrain",
      texture_data: {
        stone: { textures: "textures/blocks/stone" },
        glass: { textures: "textures/blocks/glass" },
        leaves_oak: { textures: "textures/blocks/leaves_oak" },
        grass_top: { textures: "textures/blocks/grass_top" },
        grass_side: { textures: "textures/blocks/grass_side" },
        dirt: { textures: "textures/blocks/dirt" },
        furnace_front: { textures: "textures/blocks/furnace_front" },
        furnace_side: { textures: "textures/blocks/furnace_side" },
        furnace_top: { textures: "textures/blocks/furnace_top" },
        varied_stone: {
          textures: [
            { path: "textures/blocks/varied_a", weight: 1 },
            { path: "textures/blocks/varied_b", weight: 1 },
          ],
        },
        water_still: { textures: "textures/blocks/water_still" },
        water_flow: { textures: "textures/blocks/water_flow" },
        log_oak: { textures: "textures/blocks/log_oak" },
        log_oak_top: { textures: "textures/blocks/log_oak_top" },
        big_tile: { textures: "textures/blocks/big_tile" },
        stripe: { textures: "textures/blocks/stripe" },
        // Network-palette short-name (stage 8); not referenced from blocks.json.
        palette_right_texture: {
          textures: "textures/blocks/palette_right_texture",
        },
        // Intentionally no entry for missing_only — fallback test.
      },
    }),
  );

  set(
    "textures/flipbook_textures.json",
    json([
      {
        flipbook_texture: "textures/blocks/water_still",
        atlas_tile: "water_still",
        ticks_per_frame: 2,
        frames: [0, 1, 2, 3],
      },
    ]),
  );

  set("textures/blocks/stone.png", solidPng(16, 16, 120, 120, 120));
  set("textures/blocks/glass.png", solidPng(16, 16, 180, 220, 255, 80));
  set("textures/blocks/leaves_oak.png", solidPng(16, 16, 40, 140, 40));
  set("textures/blocks/grass_top.png", solidPng(16, 16, 80, 180, 60));
  set("textures/blocks/grass_side.png", solidPng(16, 16, 100, 80, 40));
  set("textures/blocks/dirt.png", solidPng(16, 16, 90, 60, 30));
  set("textures/blocks/furnace_front.png", solidPng(16, 16, 255, 0, 0));
  set("textures/blocks/furnace_side.png", solidPng(16, 16, 0, 0, 255));
  set("textures/blocks/furnace_top.png", solidPng(16, 16, 80, 80, 80));
  set("textures/blocks/varied_a.png", solidPng(16, 16, 200, 200, 200));
  set("textures/blocks/varied_b.png", solidPng(16, 16, 50, 50, 50));
  set("textures/blocks/log_oak.png", solidPng(16, 16, 100, 70, 30));
  set("textures/blocks/log_oak_top.png", solidPng(16, 16, 160, 130, 80));
  set("textures/blocks/big_tile.png", solidPng(32, 32, 255, 128, 0));
  // Left red / right cyan — pixel test samples same phase one tile apart.
  set("textures/blocks/stripe.png", stripePng(16, [255, 0, 0], [0, 255, 255]));
  // Distinct blue for palette-only custom blocks (not magenta, not stone grey).
  set(
    "textures/blocks/palette_right_texture.png",
    solidPng(16, 16, 30, 90, 220),
  );
  set(
    "textures/blocks/water_still.png",
    flipbookPng(16, [
      [0, 0, 200],
      [0, 40, 220],
      [0, 80, 240],
      [0, 120, 255],
    ]),
  );
  set("textures/blocks/water_flow.png", solidPng(16, 16, 0, 60, 200));

  return files;
}

export interface PackFixture {
  id: string;
  priority: number;
  name?: string;
  files: Map<string, Uint8Array>;
}

/**
 * Fake asset HTTP server: /packs, /packs/index, /asset/*, /pack/<id>/*.
 *
 * @param files - Single-pack file map (defaults to {@link buildFixturePack}).
 * @returns bound server.
 */
export async function startTerrainAssetServer(
  files: Map<string, Uint8Array> = buildFixturePack(),
): Promise<TerrainAssetServer> {
  return startMultiPackAssetServer([
    { id: "vanilla", priority: 0, name: "fixture", files },
  ]);
}

/**
 * Multi-pack fixture server. Later packs in the array win `/asset` paths;
 * `/pack/<id>/…` still serves each pack's own bytes for merge tests.
 *
 * @param packs - Stack order, lowest priority first.
 * @returns bound server.
 */
export async function startMultiPackAssetServer(
  packs: PackFixture[],
): Promise<TerrainAssetServer> {
  const index: Record<string, string> = {};
  for (const pack of packs) {
    for (const path of pack.files.keys()) {
      index[path.toLowerCase()] = pack.id;
    }
  }
  const byId = new Map(packs.map((p) => [p.id, p]));

  const server: Server = createServer((req, res) => {
    handleMulti(req, res, packs, byId, index);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no bind address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Realistic two-pack stack that mirrors production failure modes:
 * - vanilla: commented blocks.json, mixed texture field shapes, path variants
 * - server: winning blocks.json with sound-only vanilla overrides + one addon block
 *
 * Stone PNG is solid lime — distinct from the magenta fallback checker.
 *
 * @returns pack fixtures (vanilla then server).
 */
export function buildRealisticPackStack(): PackFixture[] {
  const enc = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));
  const vanilla = new Map<string, Uint8Array>();
  // Mojang-shaped opener comment + mixed block texture fields.
  vanilla.set(
    "blocks.json",
    new TextEncoder().encode(`// Do not edit this file manually
{
  "format_version": ["1", "1", "0"],
  "minecraft:stone": { "textures": "stone" },
  "minecraft:grass_block": {
    "textures": {
      "up": "grass_top",
      "down": "dirt",
      "side": "grass_side"
    }
  },
  "minecraft:oak_planks": { "textures": "planks_oak" }
}
`),
  );
  vanilla.set(
    "textures/terrain_texture.json",
    enc({
      resource_pack_name: "vanilla",
      texture_name: "atlas.terrain",
      texture_data: {
        // 1) bare string
        stone: { textures: "textures/blocks/stone" },
        // 2) array of strings
        grass_top: { textures: ["textures/blocks/grass_top"] },
        // 3) object with path
        dirt: { textures: { path: "textures/blocks/dirt" } },
        // 4) array of objects with path + tint_color (tint ignored for meshing)
        grass_side: {
          textures: [
            {
              path: "blocks/grass_side",
              tint_color: "#ffffff",
              weight: 1,
            },
          ],
        },
        // path without textures/ prefix, with .png
        planks_oak: { textures: "blocks/planks_oak.png" },
      },
    }),
  );
  vanilla.set("textures/flipbook_textures.json", enc([]));
  // Lime stone — must NOT be magenta fallback when merged correctly.
  vanilla.set("textures/blocks/stone.png", solidPng(16, 16, 0, 220, 0));
  vanilla.set("textures/blocks/grass_top.png", solidPng(16, 16, 80, 180, 60));
  vanilla.set("textures/blocks/dirt.png", solidPng(16, 16, 90, 60, 30));
  vanilla.set("textures/blocks/grass_side.png", solidPng(16, 16, 100, 80, 40));
  vanilla.set("textures/blocks/planks_oak.png", solidPng(16, 16, 180, 140, 80));

  const server = new Map<string, Uint8Array>();
  // Winner for /asset/blocks.json — sound-only stone would wipe textures
  // if the viewer used winner-takes-all instead of merging.
  server.set(
    "blocks.json",
    enc({
      format_version: "1.21.40",
      "minecraft:stone": { sound: "stone" },
      "minecraft:grass_block": { sound: "grass" },
      "pokeb:apricorn_planks": { textures: "apricorn_planks", sound: "wood" },
    }),
  );
  server.set(
    "textures/terrain_texture.json",
    enc({
      resource_pack_name: "server",
      texture_name: "atlas.terrain",
      texture_data: {
        apricorn_planks: { textures: "textures/blocks/apricorn/planks" },
      },
    }),
  );
  // Bright yellow — server-pack texture via stack precedence.
  server.set(
    "textures/blocks/apricorn/planks.png",
    solidPng(16, 16, 255, 220, 0),
  );

  return [
    { id: "vanilla", priority: 0, name: "baseline", files: vanilla },
    {
      id: "server-pack",
      priority: 1,
      name: "pokebedrock",
      files: server,
    },
  ];
}

function handleMulti(
  req: IncomingMessage,
  res: ServerResponse,
  packs: PackFixture[],
  byId: Map<string, PackFixture>,
  index: Record<string, string>,
): void {
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
        name: p.name ?? p.id,
        priority: p.priority,
        fileCount: p.files.size,
      })),
    );
    return;
  }
  if (url.pathname === "/packs/index") {
    json(res, index);
    return;
  }
  if (url.pathname.startsWith("/pack/")) {
    const rest = decodeURIComponent(url.pathname.slice("/pack/".length));
    const slash = rest.indexOf("/");
    if (slash < 0) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const packId = rest.slice(0, slash);
    const rel = rest.slice(slash + 1).toLowerCase();
    if (rel.includes("..")) {
      res.writeHead(400);
      res.end("bad path");
      return;
    }
    const pack = byId.get(packId);
    const found = pack ? findFile(pack.files, rel) : undefined;
    if (!found) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    writeBytes(res, rel, found);
    return;
  }
  if (url.pathname.startsWith("/asset/")) {
    const path = decodeURIComponent(url.pathname.slice("/asset/".length));
    const key = path.toLowerCase();
    if (key.includes("..")) {
      res.writeHead(400);
      res.end("bad path");
      return;
    }
    const winner = index[key];
    const pack = winner ? byId.get(winner) : undefined;
    const found = pack ? findFile(pack.files, key) : undefined;
    if (!found) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    writeBytes(res, key, found);
    return;
  }
  res.writeHead(404);
  res.end("not found");
}

function findFile(
  files: Map<string, Uint8Array>,
  key: string,
): Uint8Array | undefined {
  const direct = files.get(key);
  if (direct) return direct;
  for (const [k, v] of files) {
    if (k.toLowerCase() === key) return v;
  }
  return undefined;
}

function writeBytes(res: ServerResponse, key: string, body: Uint8Array): void {
  const ct = key.endsWith(".json")
    ? "application/json"
    : key.endsWith(".png")
      ? "image/png"
      : "application/octet-stream";
  res.writeHead(200, { "Content-Type": ct });
  res.end(Buffer.from(body));
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
