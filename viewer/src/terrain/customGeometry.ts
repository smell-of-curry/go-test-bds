import {
  buildGeometryMeshes,
  computeBoneWorldMatrices,
  parseGeometryDocument,
  transformPoint,
  type BoneMeshBuffers,
  type ParsedGeometry,
} from "../geometry";
import type { Registries, RegistryTransform } from "../protocol";
import type { AssetClient } from "./assetClient";
import { normalizePath } from "./assetClient";
import {
  effectiveComponents,
  evalPermutationCondition,
  materialForKey,
  materialFlags,
  transformAboutBlockCenter,
} from "./permutations";
import { renderClassFromMethod } from "./palette";
import type { RenderClass } from "./types";

export interface CachedBlockGeometry {
  id: string;
  geometry: ParsedGeometry;
  bones: BoneMeshBuffers[];
}

const loggedMiss = new Set<string>();

/**
 * Engine-built-in block geometry that never ships as a pack `.geo.json`.
 * `full_block` is the plain cube; `cross` is the flower X (drawn as a cube
 * here — ponytail: proper cross shape rides the custom-geometry path later).
 *
 * @param id - `geometry.*` identifier, optionally namespaced.
 * @returns true when the id names an engine built-in.
 */
export function isBuiltinBlockGeometry(id: string): boolean {
  const bare = id.replace(/^[^:]+:/, "").toLowerCase();
  return bare === "geometry.full_block" || bare === "geometry.cross";
}

/**
 * Loads and caches `.geo.json` for custom block geometry identifiers.
 * Sync lookup at mesh time; preload via {@link preloadFromRegistries}.
 */
export class BlockGeometryCache {
  private readonly byId = new Map<string, CachedBlockGeometry | null>();
  private readonly geoPaths = new Map<string, string>();
  private geoIndexBuilt = false;
  private readonly client: AssetClient;

  /**
   * @param client - Pack asset client.
   */
  constructor(client: AssetClient) {
    this.client = client;
  }

  /**
   * @param id - `geometry.*` identifier.
   * @returns true when a parsed mesh is ready.
   */
  has(id: string): boolean {
    return !!this.byId.get(id);
  }

  /**
   * @param id - `geometry.*` identifier.
   * @returns cached geometry or null (missing / failed).
   */
  get(id: string): CachedBlockGeometry | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * Fetch every geometry id referenced by the network palette.
   *
   * @param registries - Keyframe registries.
   */
  async preloadFromRegistries(
    registries: Registries | null | undefined,
  ): Promise<void> {
    if (!registries?.blocks) return;
    const ids = new Set<string>();
    for (const b of registries.blocks) {
      const base = b.components?.geometry;
      if (base) ids.add(base);
      for (const perm of b.permutations ?? []) {
        const g = perm.components?.geometry;
        if (g) ids.add(g);
      }
      // Also resolve with empty states so base path is covered.
      const eff = effectiveComponents(b, {});
      if (eff.geometry) ids.add(eff.geometry);
    }
    await Promise.all([...ids].map((id) => this.ensure(id)));
  }

  /**
   * Load + parse one geometry id (cached).
   *
   * @param id - `geometry.*` id.
   * @returns cache entry or null.
   */
  async ensure(id: string): Promise<CachedBlockGeometry | null> {
    if (this.byId.has(id)) return this.byId.get(id) ?? null;
    // Built-ins (full_block, cross) are not pack files — cube path draws them.
    if (isBuiltinBlockGeometry(id)) {
      this.byId.set(id, null);
      return null;
    }
    let json: unknown | null = null;
    try {
      json = await this.loadGeometryJson(id);
    } catch (err) {
      // A failed fetch (400 on an odd id, network) must degrade this block to
      // the cube path, never reject the caller — run 24 lost the whole world
      // to one rejecting preload Promise.all.
      this.byId.set(id, null);
      logMissOnce(id, err instanceof Error ? err.message : "fetch");
      return null;
    }
    if (!json) {
      this.byId.set(id, null);
      logMissOnce(id, "missing");
      return null;
    }
    try {
      const doc = parseGeometryDocument(json);
      const geo =
        doc.geometries.find((g) => g.description.identifier === id) ??
        doc.geometries[0];
      if (!geo) {
        this.byId.set(id, null);
        logMissOnce(id, "empty");
        return null;
      }
      const entry: CachedBlockGeometry = {
        id,
        geometry: geo,
        bones: buildGeometryMeshes(geo),
      };
      this.byId.set(id, entry);
      return entry;
    } catch (err) {
      this.byId.set(id, null);
      logMissOnce(id, err instanceof Error ? err.message : "parse");
      return null;
    }
  }

  private async loadGeometryJson(geometryId: string): Promise<unknown | null> {
    const known = this.geoPaths.get(geometryId);
    const candidates = known
      ? [known]
      : blockGeometryPathCandidates(geometryId);
    for (const c of candidates) {
      const json = await this.client.fetchJson(c);
      if (!json) continue;
      this.geoPaths.set(geometryId, normalizePath(c));
      return json;
    }
    await this.ensureGeoIndex();
    const fromIndex = this.geoPaths.get(geometryId);
    if (!fromIndex) return null;
    return this.client.fetchJson(fromIndex);
  }

  private async ensureGeoIndex(): Promise<void> {
    if (this.geoIndexBuilt) return;
    this.geoIndexBuilt = true;
    const index = await this.client.getIndex();
    const paths = Object.keys(index).filter((p) => p.endsWith(".geo.json"));
    // Cap concurrency loosely.
    const chunk = 16;
    for (let i = 0; i < paths.length; i += chunk) {
      await Promise.all(
        paths.slice(i, i + chunk).map(async (path) => {
          const json = await this.client.fetchJson(path);
          if (!json || typeof json !== "object") return;
          for (const id of extractGeometryIdentifiers(json)) {
            if (!this.geoPaths.has(id)) this.geoPaths.set(id, path);
          }
        }),
      );
    }
  }
}

/**
 * Heuristic pack paths for a block geometry identifier.
 *
 * @param geometryId - `geometry.foo.bar`.
 * @returns candidate paths.
 */
export function blockGeometryPathCandidates(geometryId: string): string[] {
  // "minecraft:geometry.full_block" / "pokeb:geometry.foo" → namespace off
  // first (a colon in the asset path is a 400), then the geometry. prefix.
  const bare = geometryId.replace(/^[^:]+:/, "").replace(/^geometry\./i, "");
  return [
    `models/blocks/${bare}.geo.json`,
    `models/block/${bare}.geo.json`,
    `models/${bare}.geo.json`,
    `models/entity/${bare}.geo.json`,
    `models/blocks/${bare}.json`,
    `models/${bare}.json`,
  ];
}

/**
 * World-space triangles for one custom-geometry block cell.
 */
export interface CustomBlockTri {
  /** Nine floats: 3 verts × xyz. */
  positions: number[];
  /** Six floats: 3 verts × uv (0..1 within the tile). */
  uvs: number[];
  texture: string;
  pass: "opaque" | "transparent";
  faceDimming: boolean;
  ambientOcclusion: boolean;
  /** Approximate face dir 0..5 from averaged normal (for FACE_SHADE). */
  dir: 0 | 1 | 2 | 3 | 4 | 5;
  doubleSided: boolean;
}

export interface EmitCustomOpts {
  cache: BlockGeometryCache;
  geometryId: string;
  materials: Record<string, import("../protocol").RegistryMaterial> | undefined;
  boneVisibility: Record<string, unknown> | undefined;
  transformation: RegistryTransform | undefined;
  states: Record<string, unknown>;
  wx: number;
  wy: number;
  wz: number;
}

/**
 * Expand a cached geometry into world-space triangles for one block cell.
 *
 * @param opts - Cache + placement + materials.
 * @returns triangles, or null when geometry missing.
 */
export function emitCustomBlockTris(
  opts: EmitCustomOpts,
): CustomBlockTri[] | null {
  const entry = opts.cache.get(opts.geometryId);
  if (!entry) return null;

  const boneVisible = resolveBoneVisibility(
    opts.boneVisibility,
    opts.states,
    entry.geometry,
  );
  const matrices = computeBoneWorldMatrices(entry.geometry);
  const out: CustomBlockTri[] = [];

  for (const bone of entry.bones) {
    if (boneVisible && boneVisible.get(bone.boneName) === false) continue;
    const M = matrices.get(bone.boneName);
    if (!M) continue;
    const idx = bone.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const i0 = idx[i]!;
      const i1 = idx[i + 1]!;
      const i2 = idx[i + 2]!;
      const matName =
        bone.materialInstances[i0] ||
        bone.materialInstances[i1] ||
        bone.materialInstances[i2] ||
        "";
      const faceName = bone.faces[i0];
      const mat =
        materialForKey(opts.materials, matName) ??
        (faceName && faceName !== "poly"
          ? materialForKey(opts.materials, faceName)
          : undefined) ??
        materialForKey(opts.materials, "*");
      const tex = mat?.texture;
      if (!tex) continue;
      const flags = materialFlags(mat);
      const method = (mat?.renderMethod ?? "opaque").toLowerCase();
      const rc = renderClassFromMethod(mat?.renderMethod);
      const pass: "opaque" | "transparent" =
        rc === "opaque" ? "opaque" : "transparent";
      const doubleSided = method === "double_sided" || method === "blend";

      const positions: number[] = [];
      const uvs: number[] = [];
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (const vi of [i0, i1, i2]) {
        const lx = bone.positions[vi * 3]!;
        const ly = bone.positions[vi * 3 + 1]!;
        const lz = bone.positions[vi * 3 + 2]!;
        const posed = transformPoint(M, [lx, ly, lz]);
        // Model XZ centred at 0 → block-local (+0.5); Y sits on the floor.
        let bx = posed[0] + 0.5;
        let by = posed[1];
        let bz = posed[2] + 0.5;
        if (opts.transformation) {
          [bx, by, bz] = transformAboutBlockCenter(
            bx,
            by,
            bz,
            opts.transformation,
          );
        }
        positions.push(opts.wx + bx, opts.wy + by, opts.wz + bz);
        uvs.push(bone.uvs[vi * 2]!, bone.uvs[vi * 2 + 1]!);
        nx += bone.normals[vi * 3]!;
        ny += bone.normals[vi * 3 + 1]!;
        nz += bone.normals[vi * 3 + 2]!;
      }
      out.push({
        positions,
        uvs,
        texture: tex,
        pass,
        faceDimming: flags.faceDimming,
        ambientOcclusion: flags.ambientOcclusion,
        dir: normalToDir(nx, ny, nz),
        doubleSided,
      });
    }
  }
  return out;
}

/**
 * @param comps - Effective components.
 * @returns render class from materials / default opaque.
 */
export function renderClassFromComponents(
  comps: import("../protocol").RegistryComponents,
): RenderClass {
  const mats = comps.materialInstances;
  if (!mats) return "opaque";
  for (const m of Object.values(mats)) {
    if (m?.renderMethod) return renderClassFromMethod(m.renderMethod);
  }
  return "opaque";
}

function resolveBoneVisibility(
  raw: Record<string, unknown> | undefined,
  states: Record<string, unknown>,
  geometry: ParsedGeometry,
): Map<string, boolean> | null {
  if (!raw) return null;
  const out = new Map<string, boolean>();
  for (const bone of geometry.bones) out.set(bone.name, true);
  for (const [name, val] of Object.entries(raw)) {
    if (typeof val === "boolean") {
      out.set(name, val);
      continue;
    }
    if (typeof val === "string") {
      out.set(name, evalPermutationCondition(val, states, "bone"));
      continue;
    }
  }
  return out;
}

function normalToDir(
  nx: number,
  ny: number,
  nz: number,
): 0 | 1 | 2 | 3 | 4 | 5 {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  if (ay >= ax && ay >= az) return ny >= 0 ? 2 : 3;
  if (ax >= az) return nx >= 0 ? 0 : 1;
  return nz >= 0 ? 4 : 5;
}

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

function logMissOnce(id: string, reason: string): void {
  if (loggedMiss.has(id)) return;
  loggedMiss.add(id);
  console.warn(`[terrain] custom geometry fallback to cube: ${id} (${reason})`);
}
