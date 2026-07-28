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

/**
 * Fake asset HTTP server: /packs, /packs/index, /asset/*.
 *
 * @param files - Pack file map (defaults to {@link buildFixturePack}).
 * @returns bound server.
 */
export async function startTerrainAssetServer(
  files: Map<string, Uint8Array> = buildFixturePack(),
): Promise<TerrainAssetServer> {
  const index: Record<string, string> = {};
  for (const path of files.keys()) {
    index[path.toLowerCase()] = "vanilla";
  }

  const server: Server = createServer((req, res) => {
    handle(req, res, files, index);
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

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  files: Map<string, Uint8Array>,
  index: Record<string, string>,
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (url.pathname === "/packs") {
    json(res, [
      {
        id: "vanilla",
        uuid: "00000000-0000-0000-0000-000000000000",
        version: "1.0.0",
        name: "fixture",
        priority: 0,
        fileCount: files.size,
      },
    ]);
    return;
  }
  if (url.pathname === "/packs/index") {
    json(res, index);
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
    const body = files.get(key) ?? files.get(path);
    // Also try matching without relying on Map insertion case.
    let found: Uint8Array | undefined = body;
    if (!found) {
      for (const [k, v] of files) {
        if (k.toLowerCase() === key) {
          found = v;
          break;
        }
      }
    }
    if (!found) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    const ct = key.endsWith(".json")
      ? "application/json"
      : key.endsWith(".png")
        ? "image/png"
        : "application/octet-stream";
    res.writeHead(200, { "Content-Type": ct });
    res.end(Buffer.from(found));
    return;
  }
  res.writeHead(404);
  res.end("not found");
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
