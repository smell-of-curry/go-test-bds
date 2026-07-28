import type { PackIndex, PackInfo } from "./types";
import { bitmapFromTga } from "./tga";

/**
 * HTTP client for the viewer's pack asset endpoints.
 * Caches `/packs/index` and per-path bytes / decoded JSON / ImageBitmaps.
 */
export class AssetClient {
  private readonly baseUrl: string;
  private index: PackIndex | null = null;
  private readonly indexPromise: { current: Promise<PackIndex> | null } = {
    current: null,
  };
  private readonly bytes = new Map<string, Promise<ArrayBuffer | null>>();
  private readonly json = new Map<string, Promise<unknown | null>>();
  private readonly images = new Map<string, Promise<ImageBitmap | null>>();

  /**
   * @param baseUrl - Viewer HTTP origin (no trailing slash), e.g. `http://127.0.0.1:24680`.
   */
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Fetch ordered pack stack (lowest priority first).
   *
   * @returns pack infos from GET /packs.
   */
  async getPacks(): Promise<PackInfo[]> {
    const res = await fetch(`${this.baseUrl}/packs`);
    if (!res.ok) throw new Error(`GET /packs → ${res.status}`);
    const packs = (await res.json()) as PackInfo[];
    return packs.slice().sort((a, b) => a.priority - b.priority);
  }

  /**
   * Fetch and cache the resolved path → packId index.
   *
   * @returns pack index map.
   */
  async getIndex(): Promise<PackIndex> {
    if (this.index) return this.index;
    if (!this.indexPromise.current) {
      this.indexPromise.current = (async () => {
        const res = await fetch(`${this.baseUrl}/packs/index`);
        if (!res.ok) throw new Error(`GET /packs/index → ${res.status}`);
        const idx = (await res.json()) as PackIndex;
        this.index = idx;
        return idx;
      })();
    }
    return this.indexPromise.current;
  }

  /**
   * Whether any pack has the given path (after stack resolution).
   *
   * @param path - Pack-relative POSIX path (case as served; lookup lower-cased).
   * @returns true when the index maps the path.
   */
  async has(path: string): Promise<boolean> {
    const idx = await this.getIndex();
    return normalizePath(path) in idx;
  }

  /**
   * Winning pack id for a path, or null if absent.
   *
   * @param path - Pack-relative path.
   * @returns pack id or null.
   */
  async packIdFor(path: string): Promise<string | null> {
    const idx = await this.getIndex();
    return idx[normalizePath(path)] ?? null;
  }

  /**
   * Fetch winning bytes for a path. Missing → null (caller shows fallback).
   *
   * @param path - Pack-relative path.
   * @returns array buffer or null on 404.
   */
  fetchBytes(path: string): Promise<ArrayBuffer | null> {
    const key = normalizePath(path);
    let p = this.bytes.get(key);
    if (!p) {
      p = (async () => {
        const res = await fetch(
          `${this.baseUrl}/asset/${key.split("/").map(encodeURIComponent).join("/")}`,
        );
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`GET /asset/${key} → ${res.status}`);
        return res.arrayBuffer();
      })();
      this.bytes.set(key, p);
    }
    return p;
  }

  /**
   * Fetch and parse JSON from `/asset/...`.
   *
   * @param path - Pack-relative JSON path.
   * @returns parsed value or null if missing.
   */
  fetchJson<T = unknown>(path: string): Promise<T | null> {
    const key = normalizePath(path);
    let p = this.json.get(key);
    if (!p) {
      p = (async () => {
        const buf = await this.fetchBytes(key);
        if (!buf) return null;
        const text = new TextDecoder().decode(buf);
        return parsePackJson<T>(text, key);
      })();
      this.json.set(key, p);
    }
    return p as Promise<T | null>;
  }

  /**
   * Decode an image asset with `createImageBitmap` (never in Go).
   * Tries `.png`, `_opaque.png` (leaves), then `.tga` (grass_side / foliage).
   *
   * @param path - Pack-relative path, with or without `.png`.
   * @returns ImageBitmap or null when missing.
   */
  fetchImage(path: string): Promise<ImageBitmap | null> {
    const bare = normalizePath(path)
      .replace(/\.png$/i, "")
      .replace(/\.tga$/i, "");
    const key = bare;
    let p = this.images.get(key);
    if (!p) {
      p = (async () => {
        const roots = new Set<string>([
          bare,
          bare.startsWith("textures/")
            ? bare.slice("textures/".length)
            : `textures/${bare}`,
        ]);
        for (const root of roots) {
          for (const suffix of [".png", "_opaque.png"] as const) {
            const buf = await this.fetchBytes(`${root}${suffix}`);
            if (!buf) continue;
            try {
              return await createImageBitmap(
                new Blob([buf], { type: "image/png" }),
              );
            } catch {
              /* try next */
            }
          }
          const tga = await this.fetchBytes(`${root}.tga`);
          if (tga) {
            const bmp = await bitmapFromTga(tga);
            if (bmp) return bmp;
          }
        }
        return null;
      })();
      this.images.set(key, p);
    }
    return p;
  }

  /**
   * Fetch JSON from a specific pack (`GET /pack/<id>/...`), not the winner.
   * Needed so `blocks.json` / `terrain_texture.json` can be merged across the
   * stack — a server pack that only lists sound must not erase vanilla textures.
   *
   * @param packId - Pack id from GET /packs.
   * @param path - Pack-relative path.
   * @returns parsed JSON or null on 404.
   */
  async fetchPackJson<T = unknown>(
    packId: string,
    path: string,
  ): Promise<T | null> {
    const key = normalizePath(path);
    const res = await fetch(
      `${this.baseUrl}/pack/${encodeURIComponent(packId)}/${key
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`GET /pack/${packId}/${key} → ${res.status}`);
    }
    const text = await res.text();
    return parsePackJson<T>(text, `${packId}:${key}`);
  }

  /**
   * Fetch a JSON file from every pack in stack order (lowest priority first).
   * Missing packs are skipped.
   *
   * @param path - Pack-relative path.
   * @returns non-null parsed roots in stack order.
   */
  async fetchJsonLayers(path: string): Promise<unknown[]> {
    const packs = await this.getPacks();
    const layers: unknown[] = [];
    for (const pack of packs) {
      const j = await this.fetchPackJson(pack.id, path);
      if (j != null) layers.push(j);
    }
    return layers;
  }

  /** Drop caches (tests / pack reload). */
  clear(): void {
    this.index = null;
    this.indexPromise.current = null;
    this.bytes.clear();
    this.json.clear();
    this.images.clear();
  }
}

/**
 * Lower-case POSIX path used as the index key.
 *
 * @param path - Raw path.
 * @returns normalised key.
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

/**
 * Parse pack JSON the way the client accepts it.
 *
 * Bedrock pack files are not strict JSON: Mojang's own `blocks.json` opens with
 * a `//` comment, and pack authors leave trailing commas. The client reads them
 * regardless, so a viewer that insists on strict JSON refuses the vanilla
 * baseline and renders placeholders forever.
 *
 * @param text - Raw file text.
 * @param path - Path used in the error message.
 * @returns the parsed value.
 * @throws when the text is not JSON even after comments are removed.
 */
export function parsePackJson<T = unknown>(text: string, path = ""): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const stripped = stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(stripped) as T;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${path || "json"}: ${reason}`);
    }
  }
}

/**
 * Remove `//` and block comments while leaving string contents intact.
 *
 * @param text - Raw file text.
 * @returns text with comments replaced by nothing.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}
