import type { PackIndex, PackInfo } from "./types";

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
    return (await res.json()) as PackInfo[];
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
        return JSON.parse(text) as T;
      })();
      this.json.set(key, p);
    }
    return p as Promise<T | null>;
  }

  /**
   * Decode an image asset with `createImageBitmap` (never in Go).
   * Tries `.png` then the bare path.
   *
   * @param path - Pack-relative path, with or without `.png`.
   * @returns ImageBitmap or null when missing.
   */
  fetchImage(path: string): Promise<ImageBitmap | null> {
    const bare = normalizePath(path).replace(/\.png$/i, "");
    const key = bare;
    let p = this.images.get(key);
    if (!p) {
      p = (async () => {
        for (const candidate of [`${bare}.png`, bare]) {
          const buf = await this.fetchBytes(candidate);
          if (!buf) continue;
          const blob = new Blob([buf], { type: "image/png" });
          return createImageBitmap(blob);
        }
        return null;
      })();
      this.images.set(key, p);
    }
    return p;
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
