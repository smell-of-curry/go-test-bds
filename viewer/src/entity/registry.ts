import * as THREE from "three";
import type { AssetClient } from "../terrain/assetClient";
import { normalizePath } from "../terrain/assetClient";
import {
  applyEntityYaw,
  applyHeadPitch,
  buildFromPass,
  geometryById,
  type BuiltEntityModel,
} from "./buildModel";
import { parseClientEntity } from "./parseClient";
import { parseRenderControllers } from "./parseController";
import { modelCacheKey, resolveRenderPasses } from "./resolve";
import type {
  ClientEntityDef,
  EntityRenderInputs,
  RenderControllerDef,
} from "./types";

/** Minimal entity fields the registry needs (matches protocol Entity). */
export interface EntityLike {
  type: string;
  player: boolean;
  props: Record<string, string | number | boolean>;
  flags: Record<string, boolean>;
}

/**
 * Loads client entity defs + render controllers from the pack stack and builds
 * cached THREE models. Missing assets → null (caller keeps the wireframe).
 *
 * Pack enumeration uses `GET /packs/index` (path → winning pack id). Every
 * entity JSON under `entity/` and every file under `render_controllers/` is
 * fetched from the winning pack; for each identifier / controller name the
 * highest-priority pack wins.
 */
export class EntityModelRegistry {
  private readonly client: AssetClient;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  private readonly entities = new Map<string, ClientEntityDef>();
  private readonly controllers = new Map<string, RenderControllerDef>();
  /** geometry.* id → pack-relative `.geo.json` path. */
  private readonly geoPaths = new Map<string, string>();
  private readonly geoJsonCache = new Map<string, Promise<unknown | null>>();
  private readonly modelCache = new Map<
    string,
    Promise<BuiltEntityModel | null>
  >();
  private geoIndexBuilt = false;

  /**
   * @param client - Shared {@link AssetClient} (same pack stack as terrain).
   */
  constructor(client: AssetClient) {
    this.client = client;
  }

  /**
   * Load / merge client entity defs and render controllers from the pack index.
   * Safe to call multiple times (deduped).
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) this.loadPromise = this.loadInner();
    await this.loadPromise;
  }

  /**
   * @returns true after a successful {@link load}.
   */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Look up a merged client entity def by identifier.
   *
   * @param identifier - e.g. `minecraft:player`.
   * @returns def or undefined.
   */
  getClientEntity(identifier: string): ClientEntityDef | undefined {
    return this.entities.get(identifier);
  }

  /**
   * Look up a render controller by name.
   *
   * @param name - e.g. `controller.render.pokemon`.
   * @returns def or undefined.
   */
  getController(name: string): RenderControllerDef | undefined {
    return this.controllers.get(name);
  }

  /**
   * Build (or fetch cached) a model for an entity. Returns null on any failure
   * so the scene can keep the wireframe box.
   *
   * @param ent - Entity snapshot fields.
   * @returns built model or null.
   */
  async getModel(ent: EntityLike): Promise<BuiltEntityModel | null> {
    try {
      await this.load();
      const inputs = toInputs(ent);
      const def = this.entities.get(inputs.type);
      if (!def) return null;

      const passes = resolveRenderPasses(def, this.controllers, inputs);
      if (passes.length === 0) return null;

      const key = modelCacheKey(inputs, passes);
      let pending = this.modelCache.get(key);
      if (!pending) {
        pending = this.buildModel(def, passes);
        this.modelCache.set(key, pending);
      }
      const model = await pending;
      if (!model) return null;
      // Return a clone of the root hierarchy so each entity instance can pose
      // independently; GPU resources stay shared via cloned materials/geoms.
      return cloneBuiltModel(model);
    } catch {
      return null;
    }
  }

  /**
   * Apply yaw (and head pitch when a head bone exists) to a built model.
   *
   * @param model - Built model.
   * @param rot - `[yaw, pitch]` or `[yaw, pitch, headYaw]` degrees.
   */
  applyPose(
    model: BuiltEntityModel,
    rot: [number, number] | [number, number, number],
  ): void {
    applyEntityYaw(model.root, rot[0]);
    applyHeadPitch(model.bones, rot[1]);
  }

  /** Drop caches (tests). */
  clear(): void {
    this.loaded = false;
    this.loadPromise = null;
    this.entities.clear();
    this.controllers.clear();
    this.geoPaths.clear();
    this.geoJsonCache.clear();
    for (const p of this.modelCache.values()) {
      void p.then((m) => m?.dispose());
    }
    this.modelCache.clear();
    this.geoIndexBuilt = false;
  }

  /**
   * @returns internal load work.
   */
  private async loadInner(): Promise<void> {
    const packs = await this.client.getPacks();
    const priority = new Map(packs.map((p) => [p.id, p.priority]));
    const index = await this.client.getIndex();

    const entityPaths: string[] = [];
    const rcPaths: string[] = [];
    for (const path of Object.keys(index)) {
      if (isClientEntityPath(path)) entityPaths.push(path);
      else if (isRenderControllerPath(path)) rcPaths.push(path);
    }

    // Winner-per-path bytes; when two paths share an identifier, higher pack
    // priority wins.
    const entPri = new Map<string, number>();
    await mapPool(entityPaths, 24, async (path) => {
      const packId = index[path] ?? "";
      const pri = priority.get(packId) ?? -1;
      const json = await this.client.fetchJson(path);
      if (!json) return;
      const def = parseClientEntity(json, path);
      if (!def) return;
      const prev = entPri.get(def.identifier);
      if (prev !== undefined && prev > pri) return;
      entPri.set(def.identifier, pri);
      this.entities.set(def.identifier, def);
    });

    const rcPri = new Map<string, number>();
    await mapPool(rcPaths, 24, async (path) => {
      const packId = index[path] ?? "";
      const pri = priority.get(packId) ?? -1;
      const json = await this.client.fetchJson(path);
      if (!json) return;
      const parsed = parseRenderControllers(json);
      for (const [name, def] of parsed) {
        const prev = rcPri.get(name);
        if (prev !== undefined && prev > pri) continue;
        rcPri.set(name, pri);
        this.controllers.set(name, def);
      }
    });

    // Ensure a minimal default controller exists.
    if (!this.controllers.has("controller.render.default")) {
      this.controllers.set("controller.render.default", {
        name: "controller.render.default",
        geometry: "Geometry.default",
        textures: ["Texture.default"],
        materials: [{ "*": "Material.default" }],
        partVisibility: [],
        arrays: { materials: {}, geometries: {}, textures: {} },
      });
    }

    this.loaded = true;
  }

  /**
   * @param def - Client entity.
   * @param passes - Resolved controller passes.
   * @returns shared (cache) model instance.
   */
  private async buildModel(
    def: ClientEntityDef,
    passes: Awaited<ReturnType<typeof resolveRenderPasses>>,
  ): Promise<BuiltEntityModel | null> {
    // Stage 7: first successful pass only (multi-pass materials later).
    const pass = passes[0];
    if (!pass) return null;

    const geoJson = await this.loadGeometryJson(pass.geometryId);
    if (!geoJson) return null;
    const geometry = geometryById(geoJson, pass.geometryId);
    if (!geometry) return null;

    const texPath = pass.texturePaths[0];
    if (!texPath) return null;
    const bitmap = await this.client.fetchImage(texPath);
    if (!bitmap) return null;

    const texture = await bitmapToTexture(bitmap);
    const scale = await evalScale(def.scale);
    return buildFromPass(geometry, texture, pass, scale);
  }

  /**
   * Resolve a `geometry.*` identifier to its JSON document.
   *
   * @param geometryId - e.g. `geometry.humanoid.custom`.
   * @returns parsed JSON or null.
   */
  private async loadGeometryJson(geometryId: string): Promise<unknown | null> {
    const known = this.geoPaths.get(geometryId);
    const candidates = known ? [known] : geometryPathCandidates(geometryId);

    for (const c of candidates) {
      const json = await this.fetchGeoPath(c);
      if (!json) continue;
      const key = normalizePath(c);
      if (!this.geoPaths.has(geometryId)) this.geoPaths.set(geometryId, key);
      return json;
    }

    // Heuristic miss — scan pack index once for identifier → path.
    await this.ensureGeoIndex();
    const fromIndex = this.geoPaths.get(geometryId);
    if (!fromIndex) return null;
    return this.fetchGeoPath(fromIndex);
  }

  /**
   * @param path - Pack-relative geo path.
   * @returns JSON or null.
   */
  private fetchGeoPath(path: string): Promise<unknown | null> {
    const key = normalizePath(path);
    let pending = this.geoJsonCache.get(key);
    if (!pending) {
      pending = this.client.fetchJson(key);
      this.geoJsonCache.set(key, pending);
    }
    return pending;
  }

  /**
   * Scan pack index for `.geo.json` files and index `description.identifier`.
   * Runs once; large packs pay this on first geometry resolve.
   */
  private async ensureGeoIndex(): Promise<void> {
    if (this.geoIndexBuilt) return;
    this.geoIndexBuilt = true;
    const index = await this.client.getIndex();
    const paths = Object.keys(index).filter((p) => p.endsWith(".geo.json"));
    await mapPool(paths, 16, async (path) => {
      const json = await this.client.fetchJson(path);
      if (!json || typeof json !== "object") return;
      const ids = extractGeometryIdentifiers(json);
      for (const id of ids) {
        if (!this.geoPaths.has(id)) this.geoPaths.set(id, path);
      }
    });
  }
}

/**
 * @param path - Pack-relative path (lower-case).
 * @returns true when it looks like a client entity definition file.
 */
export function isClientEntityPath(path: string): boolean {
  const p = path.toLowerCase();
  if (!p.endsWith(".json")) return false;
  // entity/**/*.json but not models/entity/**
  if (p.startsWith("models/")) return false;
  if (p.startsWith("entity/")) return true;
  // subpack overlay paths are already flattened into the index as entity/…
  return false;
}

/**
 * @param path - Pack-relative path.
 * @returns true when it looks like a render controller file.
 */
export function isRenderControllerPath(path: string): boolean {
  const p = path.toLowerCase();
  return p.startsWith("render_controllers/") && p.endsWith(".json");
}

/**
 * Heuristic pack paths for a geometry identifier.
 *
 * @param geometryId - `geometry.foo.bar`.
 * @returns candidate paths.
 */
export function geometryPathCandidates(geometryId: string): string[] {
  const bare = geometryId.replace(/^geometry\./i, "");
  return [
    `models/entity/${bare}.geo.json`,
    `models/${bare}.geo.json`,
    `models/entity/${bare}.json`,
    `models/${bare}.json`,
  ];
}

/**
 * @param json - Geometry document JSON.
 * @returns identifiers found.
 */
function extractGeometryIdentifiers(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  const out: string[] = [];
  const modern = obj["minecraft:geometry"];
  if (Array.isArray(modern)) {
    for (const entry of modern) {
      if (!entry || typeof entry !== "object") continue;
      const desc = (entry as Record<string, unknown>).description;
      if (desc && typeof desc === "object") {
        const id = (desc as Record<string, unknown>).identifier;
        if (typeof id === "string") out.push(id);
      }
    }
  }
  for (const key of Object.keys(obj)) {
    if (key.startsWith("geometry.")) out.push(key);
  }
  return out;
}

/**
 * @param ent - Entity-like.
 * @returns render inputs.
 */
function toInputs(ent: EntityLike): EntityRenderInputs {
  return {
    type: ent.type,
    player: ent.player,
    props: ent.props ?? {},
    flags: ent.flags ?? {},
  };
}

/**
 * @param scaleExpr - Literal or simple number Molang.
 * @returns scale factor.
 */
async function evalScale(scaleExpr: string | undefined): Promise<number> {
  if (!scaleExpr) return 1;
  const n = Number(scaleExpr);
  if (Number.isFinite(n) && n > 0) return n;
  // Complex Molang scale — skip (Stage 9); default 1.
  return 1;
}

/**
 * @param bitmap - Decoded image.
 * @returns three.js texture.
 */
async function bitmapToTexture(bitmap: ImageBitmap): Promise<THREE.Texture> {
  const tex = new THREE.Texture(bitmap as unknown as HTMLImageElement);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Default flipY=true matches geo `texelToGl` (V grows up; image top → V=1).
  tex.needsUpdate = true;
  return tex;
}

/**
 * Clone a built model so instances can be posed/disposed independently while
 * sharing BufferGeometry + Material GPU objects.
 *
 * @param model - Shared cache entry.
 * @returns instance clone (dispose is a no-op for shared GPU resources).
 */
function cloneBuiltModel(model: BuiltEntityModel): BuiltEntityModel {
  const root = model.root.clone(true);
  const bones = new Map<string, THREE.Group>();
  root.traverse((obj) => {
    if (obj instanceof THREE.Group && obj.name && obj.name !== "entityModel") {
      bones.set(obj.name, obj);
    }
  });
  // Re-seed baseMatrix for head pitch on the clone.
  const head = bones.get("head") ?? bones.get("Head");
  if (head) head.userData.baseMatrix = head.matrix.clone();

  return {
    root,
    bones,
    scale: model.scale,
    dispose(): void {
      // Shared geometry/material/texture — only detach from scene.
      root.removeFromParent();
    },
  };
}

/**
 * Run async work over items with a concurrency limit.
 *
 * @param items - Inputs.
 * @param concurrency - Max in-flight.
 * @param fn - Worker.
 */
async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]!);
      }
    },
  );
  await Promise.all(workers);
}
