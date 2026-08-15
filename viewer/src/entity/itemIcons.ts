import type { AssetClient } from "../terrain/assetClient";
import { normalizePath } from "../terrain/assetClient";

/**
 * Resolve item ids → pack texture paths via `textures/item_texture.json`.
 *
 * Hotbar HUD currently shows text names only; this is the shared atlas lookup
 * for in-world held / dropped item sprites.
 */
export class ItemIconResolver {
  private readonly client: AssetClient;
  private table: Map<string, string> | null = null;
  private loadPromise: Promise<void> | null = null;

  /**
   * @param client - Pack asset client.
   */
  constructor(client: AssetClient) {
    this.client = client;
  }

  /**
   * Ensure `item_texture.json` is loaded.
   */
  async load(): Promise<void> {
    if (this.table) return;
    if (!this.loadPromise) this.loadPromise = this.loadInner();
    await this.loadPromise;
  }

  /**
   * @param itemName - Namespaced item id (`minecraft:diamond`).
   * @returns pack-relative texture path without extension, or null.
   */
  async resolve(itemName: string): Promise<string | null> {
    await this.load();
    if (!this.table) return null;
    const bare = itemName.replace(/^minecraft:/, "").toLowerCase();
    return (
      this.table.get(bare) ??
      this.table.get(itemName.toLowerCase()) ??
      // Convention fallback when the atlas omits an entry.
      ((await this.client.has(`textures/items/${bare}.png`))
        ? `textures/items/${bare}`
        : null)
    );
  }

  /**
   * Parse texture_data map.
   */
  private async loadInner(): Promise<void> {
    const json = await this.client.fetchJson("textures/item_texture.json");
    const table = new Map<string, string>();
    if (json && typeof json === "object") {
      const data = (json as { texture_data?: Record<string, unknown> })
        .texture_data;
      if (data && typeof data === "object") {
        for (const [key, val] of Object.entries(data)) {
          const path = texturePathOf(val);
          if (path) table.set(key.toLowerCase(), normalizePath(path));
        }
      }
    }
    this.table = table;
  }
}

/**
 * @param val - texture_data entry.
 * @returns path string or null.
 */
function texturePathOf(val: unknown): string | null {
  if (typeof val === "string") return stripExt(val);
  if (!val || typeof val !== "object") return null;
  const textures = (val as { textures?: unknown }).textures;
  if (typeof textures === "string") return stripExt(textures);
  if (Array.isArray(textures)) {
    for (const t of textures) {
      if (typeof t === "string") return stripExt(t);
      if (
        t &&
        typeof t === "object" &&
        typeof (t as { path?: string }).path === "string"
      ) {
        return stripExt((t as { path: string }).path);
      }
    }
  }
  if (typeof (val as { path?: string }).path === "string") {
    return stripExt((val as { path: string }).path);
  }
  return null;
}

/**
 * @param p - Path that may include .png.
 * @returns path without image extension.
 */
function stripExt(p: string): string {
  return p.replace(/\.(png|tga|jpg|jpeg)$/i, "");
}
