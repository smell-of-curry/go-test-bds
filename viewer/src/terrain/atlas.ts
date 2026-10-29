import type { AssetClient } from "./assetClient";
import { decodeTga } from "./tga";
import {
  flipbookFrameAt,
  parseFlipbookJson,
  parseTerrainTextureJson,
  pickVariationIndex,
} from "./parse";
import type {
  AtlasRect,
  AtlasUv,
  FlipbookEntry,
  TerrainTextureEntry,
} from "./types";

/** Sentinel short-name for the generated missing-texture tile. */
export const FALLBACK_TEXTURE = "__missing__";

/**
 * Neutral stone-grey tile for named custom blocks with no material_instances.
 * Magenta (`__missing__`) means a bug; this means "known gap, draw something".
 */
export const NEUTRAL_TEXTURE = "__neutral__";

export interface PackedTile {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bitmap: ImageBitmap;
}

export interface PackResult {
  width: number;
  height: number;
  tiles: PackedTile[];
}

/**
 * Shelf-pack rectangles into a power-of-two atlas. Mixed sizes allowed.
 *
 * @param items - Id + pixel size + bitmap.
 * @returns placements and atlas dimensions.
 */
export function packRects(
  items: ReadonlyArray<{
    id: string;
    w: number;
    h: number;
    bitmap: ImageBitmap;
  }>,
): PackResult {
  if (items.length === 0) {
    return { width: 16, height: 16, tiles: [] };
  }
  const sorted = items.slice().sort((a, b) => b.h - a.h || b.w - a.w);
  let atlasW = 16;
  const area = sorted.reduce((s, i) => s + i.w * i.h, 0);
  while (atlasW * atlasW < area * 1.2 || atlasW < sorted[0]!.w) {
    atlasW *= 2;
    if (atlasW > 8192) break;
  }

  type Shelf = { y: number; h: number; x: number };
  let tiles: PackedTile[] = [];
  let atlasH = 0;

  for (;;) {
    const shelves: Shelf[] = [];
    tiles = [];
    atlasH = 0;
    let ok = true;
    for (const item of sorted) {
      if (item.w > atlasW) {
        ok = false;
        break;
      }
      let placed: Shelf | undefined;
      for (const s of shelves) {
        if (item.h <= s.h && s.x + item.w <= atlasW) {
          placed = s;
          break;
        }
      }
      if (!placed) {
        placed = { y: atlasH, h: item.h, x: 0 };
        shelves.push(placed);
        atlasH = placed.y + item.h;
      }
      tiles.push({
        id: item.id,
        x: placed.x,
        y: placed.y,
        w: item.w,
        h: item.h,
        bitmap: item.bitmap,
      });
      placed.x += item.w;
    }
    if (ok && atlasH <= atlasW * 2) break;
    if (atlasW >= 8192) break;
    atlasW *= 2;
  }

  let height = 16;
  while (height < atlasH) height *= 2;
  return { width: atlasW, height, tiles };
}

/**
 * Terrain atlas: one OffscreenCanvas, nearest-neighbour sampling.
 */
export class TerrainAtlas {
  readonly canvas: OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  private readonly rects = new Map<string, AtlasRect>();
  private readonly terrain: Record<string, TerrainTextureEntry>;
  private readonly flipbooksByTile: Map<string, FlipbookEntry>;
  private readonly flipbookFrameH = new Map<string, number>();

  /**
   * @param canvas - Blitted atlas.
   * @param width - Atlas width.
   * @param height - Atlas height.
   * @param terrain - Parsed terrain_texture data.
   * @param flipbooks - Flipbook entries.
   * @param tiles - Packed tiles.
   */
  constructor(
    canvas: OffscreenCanvas,
    width: number,
    height: number,
    terrain: Record<string, TerrainTextureEntry>,
    flipbooks: FlipbookEntry[],
    tiles: PackedTile[],
  ) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.terrain = terrain;
    this.flipbooksByTile = new Map(flipbooks.map((f) => [f.atlasTile, f]));
    for (const t of tiles) {
      this.rects.set(t.id, { x: t.x, y: t.y, w: t.w, h: t.h });
      if (this.flipbooksByTile.has(t.id)) {
        this.flipbookFrameH.set(t.id, t.w);
      }
    }
  }

  /**
   * Pixel rect for a packed short-name, or fallback.
   *
   * @param shortName - Terrain texture key.
   * @returns atlas pixel rect.
   */
  rectOf(shortName: string): AtlasRect {
    return (
      this.rects.get(shortName) ??
      this.rects.get(FALLBACK_TEXTURE) ?? { x: 0, y: 0, w: 16, h: 16 }
    );
  }

  /**
   * @param shortName - Terrain key.
   * @returns true when packed under that id.
   */
  has(shortName: string): boolean {
    return this.rects.has(shortName);
  }

  /**
   * Resolve short-name → UV, with weighted variations + flipbook frame.
   *
   * @param shortName - Terrain key from blocks.json.
   * @param tick - Snapshot tick.
   * @param x - Block X (variation seed).
   * @param y - Block Y.
   * @param z - Block Z.
   * @returns normalised UV rect.
   */
  uvFor(
    shortName: string,
    tick: number,
    x: number,
    y: number,
    z: number,
  ): AtlasUv {
    const entry = this.terrain[shortName];
    if (entry && entry.paths.length > 1) {
      const idx = pickVariationIndex(entry.paths, x, y, z);
      const alt = `${shortName}#${idx}`;
      if (this.rects.has(alt)) return this.uvRect(alt, tick);
    }
    return this.uvRect(shortName, tick);
  }

  /**
   * UV for a packed id, applying flipbook sub-frame by tick.
   *
   * @param id - Packed tile id.
   * @param tick - Snapshot tick.
   * @returns UV.
   */
  uvRect(id: string, tick: number): AtlasUv {
    const key = this.rects.has(id) ? id : FALLBACK_TEXTURE;
    const px = this.rectOf(key);
    const fb = this.flipbooksByTile.get(key);
    if (!fb) return pxToUv(subRect(px), this.width, this.height, px);

    const frameH = this.flipbookFrameH.get(key) ?? px.w;
    const frameCount = Math.max(1, Math.floor(px.h / frameH));
    const frame = flipbookFrameAt(fb, tick, frameCount);
    const clamped = Math.max(0, Math.min(frameCount - 1, frame));
    const sub: AtlasRect = {
      x: px.x,
      y: px.y + clamped * frameH,
      w: px.w,
      h: frameH,
    };
    return pxToUv(sub, this.width, this.height, px);
  }

  /**
   * @param shortName - Key.
   * @returns terrain entry or undefined.
   */
  terrainEntry(shortName: string): TerrainTextureEntry | undefined {
    return this.terrain[shortName];
  }

  /**
   * @param atlasTile - Tile short-name.
   * @returns flipbook entry or undefined.
   */
  flipbook(atlasTile: string): FlipbookEntry | undefined {
    return this.flipbooksByTile.get(atlasTile);
  }

  /** @returns canvas used as `Texture.image`. */
  imageSource(): OffscreenCanvas {
    return this.canvas;
  }
}

export interface BuildAtlasOptions {
  /** Pre-merged terrain_texture data (short-name → entry). */
  terrain?: Record<string, TerrainTextureEntry>;
  /** Pre-merged flipbook entries. */
  flipbooks?: FlipbookEntry[];
}

/**
 * Load terrain_texture + flipbooks + images for the given short-names; pack atlas.
 * Missing paths are skipped (queries fall through to the magenta fallback tile).
 *
 * @param client - Asset client.
 * @param shortNames - Terrain short-names referenced by blocks.
 * @param opts - Optional pre-merged pack-stack data (avoids winner-only /asset).
 * @returns built atlas.
 */
export async function buildTerrainAtlas(
  client: AssetClient,
  shortNames: Iterable<string>,
  opts: BuildAtlasOptions = {},
): Promise<TerrainAtlas> {
  const terrain =
    opts.terrain ??
    parseTerrainTextureJson(
      await client.fetchJson("textures/terrain_texture.json"),
    );
  const flipbooks =
    opts.flipbooks ??
    parseFlipbookJson(
      (await client.fetchJson("textures/flipbook_textures.json")) ?? [],
    );

  const needed = new Set<string>();
  for (const n of shortNames) {
    needed.add(n);
    const entry = terrain[n];
    if (entry) {
      for (let i = 0; i < entry.paths.length; i++) needed.add(`${n}#${i}`);
    }
  }
  for (const f of flipbooks) needed.add(f.atlasTile);

  const images: Array<{
    id: string;
    w: number;
    h: number;
    bitmap: ImageBitmap;
  }> = [
    {
      id: FALLBACK_TEXTURE,
      w: 16,
      h: 16,
      bitmap: await makeFallbackBitmap(16),
    },
    {
      id: NEUTRAL_TEXTURE,
      w: 16,
      h: 16,
      bitmap: await makeNeutralBitmap(16),
    },
  ];
  const loaded = new Set<string>([FALLBACK_TEXTURE, NEUTRAL_TEXTURE]);

  for (const name of needed) {
    if (loaded.has(name)) continue;
    if (!name.includes("#") && textureUsesOverlay(terrain, name)) {
      const split = await loadSplitOverlay(client, name, terrain);
      if (split) {
        images.push({
          id: name,
          w: split.base.width,
          h: split.base.height,
          bitmap: split.base,
        });
        images.push({
          id: `${name}#overlay`,
          w: split.over.width,
          h: split.over.height,
          bitmap: split.over,
        });
        loaded.add(name);
        loaded.add(`${name}#overlay`);
        continue;
      }
    }
    const bitmap = await loadTileBitmap(client, name, terrain, flipbooks);
    if (!bitmap) continue;
    images.push({ id: name, w: bitmap.width, h: bitmap.height, bitmap });
    loaded.add(name);

    const hashIdx = name.indexOf("#");
    if (hashIdx >= 0 && name.endsWith("#0")) {
      const base = name.slice(0, hashIdx);
      if (!loaded.has(base)) {
        images.push({
          id: base,
          w: bitmap.width,
          h: bitmap.height,
          bitmap,
        });
        loaded.add(base);
      }
    }
  }

  for (const n of shortNames) {
    if (loaded.has(n)) continue;
    const bitmap = await loadTileBitmap(client, n, terrain, flipbooks);
    if (!bitmap) continue;
    images.push({ id: n, w: bitmap.width, h: bitmap.height, bitmap });
    loaded.add(n);
  }

  const packed = packRects(images);
  const canvas = new OffscreenCanvas(packed.width, packed.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d unavailable");
  ctx.imageSmoothingEnabled = false;
  for (const t of packed.tiles) ctx.drawImage(t.bitmap, t.x, t.y);

  return new TerrainAtlas(
    canvas,
    packed.width,
    packed.height,
    terrain,
    flipbooks,
    packed.tiles,
  );
}

async function loadTileBitmap(
  client: AssetClient,
  name: string,
  terrain: Record<string, TerrainTextureEntry>,
  flipbooks: FlipbookEntry[],
): Promise<ImageBitmap | null> {
  const hashIdx = name.indexOf("#");
  const base = hashIdx >= 0 ? name.slice(0, hashIdx) : name;
  const varIdx = hashIdx >= 0 ? Number(name.slice(hashIdx + 1)) : 0;

  const fb = flipbooks.find((f) => f.atlasTile === base);
  if (fb && hashIdx < 0) return client.fetchImage(fb.flipbookTexture);

  const entry = terrain[base];
  const path = entry?.paths[varIdx]?.path ?? entry?.paths[0]?.path;
  if (path) {
    const img = await client.fetchImage(path);
    if (img) return img;
  }
  if (hashIdx < 0) return client.fetchImage(`textures/blocks/${base}`);
  return null;
}

function textureUsesOverlay(
  terrain: Record<string, TerrainTextureEntry>,
  name: string,
): boolean {
  const entry = terrain[name];
  return !!entry?.paths.some((p) => p.overlay);
}

/**
 * Grass-side textures store the dirt in RGB with alpha 0 and the tint mask
 * in the opaque pixels. Split them so the canvas blit (which drops RGB of
 * transparent pixels) keeps both: dirt tile + grayscale overlay tile.
 *
 * @param client - Asset client.
 * @param name - Terrain short-name.
 * @param terrain - Parsed terrain_texture data.
 * @returns two bitmaps, or null when the source has no mask.
 */
async function loadSplitOverlay(
  client: AssetClient,
  name: string,
  terrain: Record<string, TerrainTextureEntry>,
): Promise<{ base: ImageBitmap; over: ImageBitmap } | null> {
  const path = terrain[name]?.paths[0]?.path;
  if (!path) return null;
  const raw = await loadRawRgba(client, path);
  if (!raw) return null;
  const split = splitOverlayRgba(raw.rgba);
  if (!split) return null;
  const [base, over] = await Promise.all([
    bitmapFromRgba(raw.width, raw.height, split.base),
    bitmapFromRgba(raw.width, raw.height, split.over),
  ]);
  return { base, over };
}

function splitOverlayRgba(
  rgba: Uint8ClampedArray,
): { base: Uint8ClampedArray; over: Uint8ClampedArray } | null {
  let low = false;
  let high = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i]! < 16) low = true;
    else if (rgba[i]! > 240) high = true;
    if (low && high) break;
  }
  if (!low || !high) return null;
  const base = new Uint8ClampedArray(rgba.length);
  const over = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    if (a > 240) {
      over[i] = rgba[i]!;
      over[i + 1] = rgba[i + 1]!;
      over[i + 2] = rgba[i + 2]!;
      over[i + 3] = 255;
    } else {
      base[i] = rgba[i]!;
      base[i + 1] = rgba[i + 1]!;
      base[i + 2] = rgba[i + 2]!;
      base[i + 3] = 255;
    }
  }
  return { base, over };
}

async function bitmapFromRgba(
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d unavailable");
  const pixels = new Uint8ClampedArray(rgba) as Uint8ClampedArray<ArrayBuffer>;
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  return createImageBitmap(canvas);
}

async function loadRawRgba(
  client: AssetClient,
  path: string,
): Promise<{ width: number; height: number; rgba: Uint8ClampedArray } | null> {
  const bare = path.replace(/\.(png|tga)$/i, "");
  const tga = await client.fetchBytes(`${bare}.tga`);
  if (tga) {
    const decoded = decodeTga(tga);
    if (decoded) return decoded;
  }
  const png = await client.fetchBytes(`${bare}.png`);
  if (!png) return null;
  const bmp = await createImageBitmap(new Blob([png], { type: "image/png" }), {
    premultiplyAlpha: "none",
  });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.globalCompositeOperation = "copy";
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return {
    width: bmp.width,
    height: bmp.height,
    rgba: new Uint8ClampedArray(img.data),
  };
}

function subRect(px: AtlasRect): AtlasRect {
  return { x: px.x, y: px.y, w: px.w, h: px.h };
}

function pxToUv(
  sub: AtlasRect,
  atlasW: number,
  atlasH: number,
  full: AtlasRect,
): AtlasUv {
  // three.js / WebGL: v=0 at bottom of texture image unless flipY.
  // OffscreenCanvas blit has y=0 at top; convert so v0 < v1 in GL space.
  return {
    u0: sub.x / atlasW,
    v0: 1 - (sub.y + sub.h) / atlasH,
    u1: (sub.x + sub.w) / atlasW,
    v1: 1 - sub.y / atlasH,
    px: full,
  };
}

/**
 * Magenta/black checker — visible missing-texture marker (not a Mojang asset).
 *
 * @param size - Tile edge in pixels.
 * @returns ImageBitmap.
 */
export async function makeFallbackBitmap(size: number): Promise<ImageBitmap> {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d unavailable");
  const half = size / 2;
  ctx.fillStyle = "#ff00ff";
  ctx.fillRect(0, 0, half, half);
  ctx.fillRect(half, half, half, half);
  ctx.fillStyle = "#000000";
  ctx.fillRect(half, 0, half, half);
  ctx.fillRect(0, half, half, half);
  return createImageBitmap(c);
}

/**
 * Flat stone-grey tile for palette entries without material_instances.
 *
 * @param size - Tile edge in pixels.
 * @returns ImageBitmap.
 */
export async function makeNeutralBitmap(size: number): Promise<ImageBitmap> {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d unavailable");
  ctx.fillStyle = "#8a8a8a";
  ctx.fillRect(0, 0, size, size);
  return createImageBitmap(c);
}
