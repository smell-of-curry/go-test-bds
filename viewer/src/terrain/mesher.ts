import * as THREE from "three";
import type { Mesher } from "../scene";
import type { Block } from "../protocol";
import { columnKey, sectionIndex } from "../protocol";
import type { DecodedSection, StoredColumn, WorldState } from "../store";
import { FALLBACK_TEXTURE, type TerrainAtlas } from "./atlas";
import {
  blockEntityKind,
  indexBlockEntities,
  meshBlockEntity,
} from "./blockEntities";
import { biomeAtFromState, tintAt } from "./biome";
import {
  emitCustomBlockTris,
  type BlockGeometryCache,
  type CustomBlockTri,
} from "./customGeometry";
import { aoFactor, combinedLight, FACE_SHADE, lightBrightness } from "./light";
import { createTerrainMaterial } from "./material";
import {
  isAir,
  isInvisible,
  isWaterlogFluid,
  type BlockModelResolver,
} from "./resolve";
import type {
  AtlasUv,
  BiomeAt,
  CustomGeometryHook,
  TerrainSection,
} from "./types";

type Dir = 0 | 1 | 2 | 3 | 4 | 5;

/** +X -X +Y -Y +Z -Z */
const DIRS: ReadonlyArray<{
  dir: Dir;
  dx: number;
  dy: number;
  dz: number;
  face: "east" | "west" | "up" | "down" | "south" | "north";
  uAxis: 0 | 1 | 2;
  vAxis: 0 | 1 | 2;
}> = [
  { dir: 0, dx: 1, dy: 0, dz: 0, face: "east", uAxis: 2, vAxis: 1 },
  { dir: 1, dx: -1, dy: 0, dz: 0, face: "west", uAxis: 2, vAxis: 1 },
  { dir: 2, dx: 0, dy: 1, dz: 0, face: "up", uAxis: 0, vAxis: 2 },
  { dir: 3, dx: 0, dy: -1, dz: 0, face: "down", uAxis: 0, vAxis: 2 },
  { dir: 4, dx: 0, dy: 0, dz: 1, face: "south", uAxis: 0, vAxis: 1 },
  { dir: 5, dx: 0, dy: 0, dz: -1, face: "north", uAxis: 0, vAxis: 1 },
];

interface EmitStats {
  quadsBeforeMerge: number;
  quadsAfterMerge: number;
  triangles: number;
}

/**
 * Textured terrain mesher — drop-in {@link Mesher}.
 * Face culling matches PlaceholderMesher's unknown-neighbour policy.
 * Coplanar same-texture faces are greedily merged; translucent/cutout/liquid
 * faces go into a second transparent pass.
 */
export class TexturedMesher implements Mesher {
  private atlas: TerrainAtlas;
  private readonly resolver: BlockModelResolver;
  private readonly biomeAt: BiomeAt | null;
  private readonly custom: CustomGeometryHook | null;
  private geoCache: BlockGeometryCache | null;
  /** Smooth lighting + AO; default on (goldens regenerate with this path). */
  readonly smoothLighting: boolean;
  /** Daylight factor 0..1 applied to sky light (1 = noon). */
  skyDarken: number;
  private texture: THREE.CanvasTexture;
  private readonly matOpaque: THREE.RawShaderMaterial;
  private readonly matTransparent: THREE.RawShaderMaterial;
  /** Last mesh stats (tests / debug). */
  lastStats: EmitStats = {
    quadsBeforeMerge: 0,
    quadsAfterMerge: 0,
    triangles: 0,
  };

  /**
   * @param atlas - Packed terrain atlas.
   * @param resolver - Block state → model.
   * @param opts - Optional biome lookup, custom geometry, smooth-lighting flag.
   */
  constructor(
    atlas: TerrainAtlas,
    resolver: BlockModelResolver,
    opts?: {
      biomeAt?: BiomeAt | null;
      customGeometry?: CustomGeometryHook | null;
      /** Preloaded custom-block geometry cache. */
      geometryCache?: BlockGeometryCache | null;
      /** Per-vertex light + AO. Default true. */
      smoothLighting?: boolean;
      /** Sky daylight factor 0..1. Default 1 (noon). */
      skyDarken?: number;
    },
  ) {
    this.atlas = atlas;
    this.resolver = resolver;
    this.biomeAt = opts?.biomeAt ?? null;
    this.custom = opts?.customGeometry ?? null;
    this.geoCache = opts?.geometryCache ?? null;
    this.smoothLighting = opts?.smoothLighting !== false;
    this.skyDarken = opts?.skyDarken ?? 1;

    this.texture = new THREE.CanvasTexture(atlas.imageSource());
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    // flipY=true matches atlas UV math (canvas y=0 at top → GL v=1).
    this.texture.flipY = true;
    // RawShaderMaterial samples as-authored; no sRGB→linear darkening.
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;

    this.matOpaque = createTerrainMaterial({
      map: this.texture,
      atlasWidth: atlas.width,
      atlasHeight: atlas.height,
    });
    this.matTransparent = createTerrainMaterial({
      map: this.texture,
      atlasWidth: atlas.width,
      atlasHeight: atlas.height,
      transparent: true,
    });
  }

  /**
   * Replace the geometry cache (after registry preload).
   *
   * @param cache - Cache or null.
   */
  setGeometryCache(cache: BlockGeometryCache | null): void {
    this.geoCache = cache;
  }

  /**
   * Push distance-fog uniforms into both terrain passes (matches scene fog).
   *
   * @param color - Fog RGB 0..1, or null to disable.
   * @param near - Fog start distance.
   * @param far - Fog end distance.
   */
  setFog(
    color: { r: number; g: number; b: number } | null,
    near = 0,
    far = 1,
  ): void {
    for (const mat of [this.matOpaque, this.matTransparent]) {
      const u = mat.uniforms;
      if (color) {
        (u.fogColor!.value as THREE.Vector3).set(color.r, color.g, color.b);
        u.fogNear!.value = near;
        u.fogFar!.value = far;
        u.fogEnabled!.value = 1;
      } else {
        u.fogEnabled!.value = 0;
      }
    }
  }

  /**
   * Remesh one section.
   *
   * @param section - Decoded section (optional layer-1 via duck typing).
   * @param column - Parent column.
   * @param state - World state for neighbours + tick.
   * @returns meshes (opaque then transparent) + exposed block instance count.
   */
  meshSection(
    section: DecodedSection,
    column: StoredColumn,
    state: WorldState,
  ): { meshes: THREE.Mesh[]; instanceCount: number } {
    const terrainSec = section as TerrainSection;
    const tick = state.tick;
    const originX = column.x * 16;
    const originZ = column.z * 16;
    const originY = section.y * 16;
    const cx = column.x;
    const cz = column.z;
    const sy = section.y;
    // Prefer column wire biomes; fall back to constructor hook.
    const columnBiome = biomeAtFromState(state);
    const biomeAt: BiomeAt = (x, z) =>
      columnBiome(x, z) ?? this.biomeAt?.(x, z) ?? null;

    let quadsBefore = 0;
    let instanceCount = 0;

    type FaceEmit = MergeQuad;

    const emits: FaceEmit[] = [];
    const customTris: Array<{
      tri: CustomBlockTri;
      lx: number;
      ly: number;
      lz: number;
      emission: number;
      tick: number;
    }> = [];
    const beByPos = indexBlockEntities(column.blockEntities ?? []);
    const beMeshes: THREE.Mesh[] = [];

    const blockAt = (lx: number, ly: number, lz: number): Block | undefined => {
      return neighbourBlock(state, cx, cz, sy, lx, ly, lz);
    };

    const lightCtx: LightCtx = {
      state,
      cx,
      cz,
      sy,
      resolver: this.resolver,
      skyDarken: this.skyDarken,
      smooth: this.smoothLighting,
    };

    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        for (let y = 0; y < 16; y++) {
          const pi = section.indices[sectionIndex(x, y, z)]!;
          const block = section.palette[pi];
          if (!block || isInvisible(block)) {
            this.emitLayer1(
              terrainSec,
              x,
              y,
              z,
              originX,
              originY,
              originZ,
              tick,
              blockAt,
              biomeAt,
              emits,
              () => {
                quadsBefore++;
              },
            );
            continue;
          }

          const wx = originX + x;
          const wy = originY + y;
          const wz = originZ + z;

          if (this.custom?.tryMesh(block, wx, wy, wz)) continue;

          // Vanilla chests/signs/… → dedicated meshes (not atlas cubes).
          if (blockEntityKind(block.name)) {
            const be = beByPos.get(`${wx},${wy},${wz}`);
            for (const m of meshBlockEntity(block, be, wx, wy, wz)) {
              beMeshes.push(m);
            }
            instanceCount++;
            continue;
          }

          const rc = this.resolver.renderClassOf(block);
          if (rc === "liquid") {
            this.emitLiquidCell(
              block,
              x,
              y,
              z,
              wx,
              wy,
              wz,
              tick,
              blockAt,
              biomeAt,
              emits,
              () => {
                quadsBefore++;
              },
            );
            instanceCount++;
            continue;
          }

          const cube = this.resolver.resolveCube(block, wx, wy, wz);
          if (!cube) continue;

          // Custom .geo.json path — not greedy-merged; neighbours not occluded.
          if (
            cube.customGeometryKey &&
            this.geoCache?.has(cube.customGeometryKey)
          ) {
            const tris = emitCustomBlockTris({
              cache: this.geoCache,
              geometryId: cube.customGeometryKey,
              materials: cube.materialInstances,
              boneVisibility: cube.boneVisibility,
              transformation: cube.transformation,
              states: block.states,
              wx,
              wy,
              wz,
            });
            if (tris && tris.length) {
              for (const tri of tris) {
                customTris.push({
                  tri,
                  lx: x,
                  ly: y,
                  lz: z,
                  emission: cube.lightEmission ?? 0,
                  tick,
                });
                quadsBefore++;
              }
              instanceCount++;
              this.emitLayer1(
                terrainSec,
                x,
                y,
                z,
                originX,
                originY,
                originZ,
                tick,
                blockAt,
                biomeAt,
                emits,
                () => {
                  quadsBefore++;
                },
              );
              continue;
            }
          }

          let exposed = false;
          const pass: "opaque" | "transparent" =
            cube.renderClass === "opaque" ? "opaque" : "transparent";
          const faceDim = cube.faceDimming !== false;
          const skipAo = cube.ambientOcclusion === false;
          const emission = cube.lightEmission ?? 0;

          for (const d of DIRS) {
            const nb = blockAt(x + d.dx, y + d.dy, z + d.dz);
            if (!shouldDrawFace(this.resolver, block, nb)) continue;
            exposed = true;
            quadsBefore++;
            const app = cube.faces[d.face];
            const texName = app.texture || FALLBACK_TEXTURE;
            const uv = this.atlas.uvFor(texName, tick, wx, wy, wz);
            const tint = tintAt(biomeAt, app.tint, wx, wz);
            const color = new THREE.Color(tint.r, tint.g, tint.b);
            if (emission > 0) {
              const e = Math.min(1, emission);
              color.r = Math.min(1, color.r + e);
              color.g = Math.min(1, color.g + e);
              color.b = Math.min(1, color.b + e);
            }
            const key = `${pass}|${d.dir}|${texName}|${app.tint}|${app.rotation}|${uv.u0},${uv.v0},${uv.u1},${uv.v1}|${faceDim ? 1 : 0}|${skipAo ? 0 : 1}`;
            emits.push({
              key,
              pass,
              dir: d.dir,
              x,
              y,
              z,
              du: 1,
              dv: 1,
              uv,
              rotation: app.rotation,
              color,
              yTop: 1,
              yBot: 0,
              skipFaceShade: !faceDim,
              skipAo,
            });
          }
          if (exposed) instanceCount++;

          this.emitLayer1(
            terrainSec,
            x,
            y,
            z,
            originX,
            originY,
            originZ,
            tick,
            blockAt,
            biomeAt,
            emits,
            () => {
              quadsBefore++;
            },
          );
        }
      }
    }

    // Smooth lighting needs per-unit-face corners; skip greedy merge when on.
    const merged = this.smoothLighting
      ? (emits as MergeQuad[])
      : greedyMerge(emits as MergeQuad[]);
    this.lastStats = {
      quadsBeforeMerge: quadsBefore,
      quadsAfterMerge: merged.length + customTris.length,
      triangles: merged.length * 2 + customTris.length,
    };

    const opaque = emptyBuffers();
    const trans = emptyBuffers();

    for (const q of merged) {
      const d = DIRS[q.dir]!;
      pushMergedQuad(
        q.pass === "opaque" ? opaque : trans,
        originX,
        originY,
        originZ,
        q,
        d,
        lightCtx,
      );
    }

    for (const c of customTris) {
      pushCustomTri(
        c.tri.pass === "opaque" ? opaque : trans,
        c.tri,
        c.lx,
        c.ly,
        c.lz,
        c.emission,
        c.tick,
        this.atlas,
        lightCtx,
      );
    }

    const meshes: THREE.Mesh[] = [];
    if (opaque.pos.length > 0) {
      meshes.push(makeMesh(opaque, this.matOpaque, "opaque"));
    }
    if (trans.pos.length > 0) {
      meshes.push(makeMesh(trans, this.matTransparent, "transparent"));
    }
    for (const m of beMeshes) meshes.push(m);
    return { meshes, instanceCount };
  }

  private emitLayer1(
    section: TerrainSection,
    x: number,
    y: number,
    z: number,
    originX: number,
    originY: number,
    originZ: number,
    tick: number,
    blockAt: (x: number, y: number, z: number) => Block | undefined,
    biomeAt: BiomeAt,
    emits: MergeQuad[],
    onQuad: () => void,
  ): void {
    if (!section.indices1 || !section.palette1) return;
    const pi = section.indices1[sectionIndex(x, y, z)]!;
    const fluid = section.palette1[pi];
    if (!fluid || isAir(fluid) || !isWaterlogFluid(fluid)) return;
    this.emitLiquidCell(
      fluid,
      x,
      y,
      z,
      originX + x,
      originY + y,
      originZ + z,
      tick,
      blockAt,
      biomeAt,
      emits,
      onQuad,
    );
  }

  private emitLiquidCell(
    block: Block,
    x: number,
    y: number,
    z: number,
    wx: number,
    wy: number,
    wz: number,
    tick: number,
    blockAt: (x: number, y: number, z: number) => Block | undefined,
    biomeAt: BiomeAt,
    emits: MergeQuad[],
    onQuad: () => void,
  ): void {
    const model = this.resolver.resolveLiquid(block);
    if (!model) return;
    const height = liquidHeight(model.depth);
    const tint = tintAt(biomeAt, model.tint, wx, wz);
    const color = new THREE.Color(tint.r, tint.g, tint.b);
    const still = this.atlas.uvFor(model.textureStill, tick, wx, wy, wz);
    const flow = this.atlas.uvFor(model.textureFlow, tick, wx, wy, wz);
    const useFlow = model.flowYaw != null;
    const flowRot = useFlow ? yawToRot(model.flowYaw!) : 0;

    // Top surface always (unless blocked by liquid above).
    const above = blockAt(x, y + 1, z);
    if (!above || this.resolver.renderClassOf(above) !== "liquid") {
      onQuad();
      const key = `transparent|2|${model.textureStill}|${model.tint}|top`;
      emits.push({
        key,
        pass: "transparent",
        dir: 2,
        x,
        y,
        z,
        du: 1,
        dv: 1,
        uv: useFlow ? flow : still,
        rotation: flowRot,
        color,
        yTop: height,
        yBot: 0,
      });
    }

    // Sides where neighbour is not liquid / not opaque.
    for (const d of DIRS) {
      if (d.dy !== 0) continue;
      const nb = blockAt(x + d.dx, y + d.dy, z + d.dz);
      if (nb && this.resolver.renderClassOf(nb) === "liquid") continue;
      if (nb && this.resolver.occludes(nb)) continue;
      // Unknown neighbour → exposed (same policy).
      onQuad();
      const key = `transparent|${d.dir}|${model.textureFlow}|${model.tint}|side`;
      emits.push({
        key,
        pass: "transparent",
        dir: d.dir,
        x,
        y,
        z,
        du: 1,
        dv: 1,
        uv: flow,
        rotation: flowRot,
        color,
        yTop: height,
        yBot: 0,
      });
    }
  }

  /**
   * Swap the terrain atlas (e.g. after late-bound registries pack new tiles).
   * Keeps the same material objects so already-meshed sections stay valid once remeshed.
   *
   * @param atlas - Newly built atlas.
   */
  replaceAtlas(atlas: TerrainAtlas): void {
    this.atlas = atlas;
    this.texture.dispose();
    this.texture = new THREE.CanvasTexture(atlas.imageSource());
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = true;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.needsUpdate = true;
    this.matOpaque.uniforms.map!.value = this.texture;
    this.matOpaque.uniforms.atlasSize!.value.set(atlas.width, atlas.height);
    this.matTransparent.uniforms.map!.value = this.texture;
    this.matTransparent.uniforms.atlasSize!.value.set(
      atlas.width,
      atlas.height,
    );
  }

  /** Release GPU resources. */
  dispose(): void {
    this.texture.dispose();
    this.matOpaque.dispose();
    this.matTransparent.dispose();
  }
}

/**
 * Unknown-neighbour policy (match PlaceholderMesher): missing/requested column
 * → not occluding (face kept). Absent section in known column → air.
 *
 * @param state - World.
 * @param cx - Column X.
 * @param cz - Column Z.
 * @param sy - Section Y.
 * @param lx - Local neighbour X (may be outside 0..15).
 * @param ly - Local neighbour Y.
 * @param lz - Local neighbour Z.
 * @returns neighbour block or undefined when air/unknown.
 */
export function neighbourBlock(
  state: WorldState,
  cx: number,
  cz: number,
  sy: number,
  lx: number,
  ly: number,
  lz: number,
): Block | undefined {
  let ncx = cx;
  let ncz = cz;
  let nsy = sy;
  let x = lx;
  let y = ly;
  let z = lz;
  if (x < 0) {
    ncx--;
    x = 15;
  } else if (x > 15) {
    ncx++;
    x = 0;
  }
  if (y < 0) {
    nsy--;
    y = 15;
  } else if (y > 15) {
    nsy++;
    y = 0;
  }
  if (z < 0) {
    ncz--;
    z = 15;
  } else if (z > 15) {
    ncz++;
    z = 0;
  }

  const col = state.columns.get(columnKey(ncx, ncz));
  if (!col || col.state === "requested") return undefined;
  const sec = col.sections.get(nsy);
  if (!sec) return undefined;
  const idx = sec.indices[sectionIndex(x, y, z)]!;
  return sec.palette[idx];
}

function shouldDrawFace(
  resolver: BlockModelResolver,
  self: Block,
  neighbour: Block | undefined,
): boolean {
  // Unknown / air → exposed.
  if (!neighbour || isAir(neighbour)) return true;
  if (resolver.occludes(neighbour)) return false;
  // Same translucent / cutout against itself → cull shared face.
  if (
    self.name === neighbour.name &&
    (resolver.renderClassOf(self) === "translucent" ||
      resolver.renderClassOf(self) === "cutout")
  ) {
    return false;
  }
  return true;
}

/** Bedrock liquid_depth 0 = full; 1..7 = lower. */
export function liquidHeight(depth: number): number {
  if (depth <= 0) return 14 / 16;
  return Math.max(2 / 16, (8 - depth) / 8) * (14 / 16);
}

function yawToRot(yaw: number): 0 | 1 | 2 | 3 {
  return (((Math.round(yaw / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
}

interface MergeQuad {
  key: string;
  pass: "opaque" | "transparent";
  dir: Dir;
  x: number;
  y: number;
  z: number;
  du: number;
  dv: number;
  uv: AtlasUv;
  rotation: 0 | 1 | 2 | 3;
  color: THREE.Color;
  yTop: number;
  yBot: number;
  /** When true, skip FACE_SHADE (material face_dimming: false). */
  skipFaceShade?: boolean;
  /** When true, skip AO bake (material ambient_occlusion: false). */
  skipAo?: boolean;
}

interface MeshBuffers {
  pos: number[];
  tileUv: number[];
  atlasRect: number[];
  tileRot: number[];
  col: number[];
}

function emptyBuffers(): MeshBuffers {
  return { pos: [], tileUv: [], atlasRect: [], tileRot: [], col: [] };
}

/**
 * Greedy-merge unit quads that share key + coplanar adjacency.
 *
 * @param emits - Unit faces.
 * @returns merged quads.
 */
export function greedyMerge(emits: MergeQuad[]): MergeQuad[] {
  // Group by dir + key + yTop/yBot (liquids).
  const groups = new Map<string, MergeQuad[]>();
  for (const e of emits) {
    const gk = `${e.pass}|${e.dir}|${e.key}|${e.yTop}|${e.yBot}`;
    let g = groups.get(gk);
    if (!g) {
      g = [];
      groups.set(gk, g);
    }
    g.push({ ...e });
  }

  const out: MergeQuad[] = [];
  for (const group of groups.values()) {
    if (group.length === 0) continue;
    const dir = group[0]!.dir;
    const d = DIRS[dir]!;
    // Build occupancy on the two axes orthogonal to the face normal.
    const cells = new Map<string, MergeQuad>();
    for (const q of group) {
      cells.set(`${q.x},${q.y},${q.z}`, q);
    }

    const used = new Set<string>();
    for (const q of group) {
      const ck = `${q.x},${q.y},${q.z}`;
      if (used.has(ck)) continue;

      // Expand along u then v.
      let du = 1;
      let dv = 1;
      const uStep = axisDelta(d.uAxis);
      const vStep = axisDelta(d.vAxis);

      // Grow U
      for (;;) {
        const nx = q.x + uStep[0]! * du;
        const ny = q.y + uStep[1]! * du;
        const nz = q.z + uStep[2]! * du;
        const nk = `${nx},${ny},${nz}`;
        if (!cells.has(nk) || used.has(nk)) break;
        du++;
      }
      // Grow V
      growV: for (;;) {
        for (let i = 0; i < du; i++) {
          const nx = q.x + uStep[0]! * i + vStep[0]! * dv;
          const ny = q.y + uStep[1]! * i + vStep[1]! * dv;
          const nz = q.z + uStep[2]! * i + vStep[2]! * dv;
          const nk = `${nx},${ny},${nz}`;
          if (!cells.has(nk) || used.has(nk)) break growV;
        }
        dv++;
      }

      for (let i = 0; i < du; i++) {
        for (let j = 0; j < dv; j++) {
          const nx = q.x + uStep[0]! * i + vStep[0]! * j;
          const ny = q.y + uStep[1]! * i + vStep[1]! * j;
          const nz = q.z + uStep[2]! * i + vStep[2]! * j;
          used.add(`${nx},${ny},${nz}`);
        }
      }

      out.push({ ...q, du, dv });
    }
  }
  return out;
}

function axisDelta(axis: 0 | 1 | 2): [number, number, number] {
  if (axis === 0) return [1, 0, 0];
  if (axis === 1) return [0, 1, 0];
  return [0, 0, 1];
}

interface LightCtx {
  state: WorldState;
  cx: number;
  cz: number;
  sy: number;
  resolver: BlockModelResolver;
  skyDarken: number;
  smooth: boolean;
}

function pushMergedQuad(
  buf: MeshBuffers,
  originX: number,
  originY: number,
  originZ: number,
  q: MergeQuad,
  d: (typeof DIRS)[number],
  light: LightCtx,
): void {
  const x0 = originX + q.x;
  const y0 = originY + q.y;
  const z0 = originZ + q.z;
  const { du, dv, uv, color, yTop, yBot, rotation } = q;

  const corners = faceCorners(d.dir, x0, y0, z0, du, dv, yBot, yTop);
  // Tile-space UVs matched to faceCorners order (CCW outward).
  // +Y uses v along +Z first in the corner list — see faceCorners(dir=2).
  const tileCorners = tileCornersForDir(d.dir, du, dv);
  const rect: [number, number, number, number] = [
    Math.min(uv.u0, uv.u1),
    Math.min(uv.v0, uv.v1),
    Math.abs(uv.u1 - uv.u0),
    Math.abs(uv.v1 - uv.v0),
  ];
  const shade = q.skipFaceShade ? 1 : (FACE_SHADE[d.dir] ?? 1);
  // Corner brightness multipliers (tint × face shade × light × AO).
  const cornerMul = vertexLightMultipliers(q, d, light, shade);
  const order = [0, 1, 2, 0, 2, 3];
  for (const i of order) {
    const c = corners[i]!;
    buf.pos.push(c[0], c[1], c[2]);
    const t = tileCorners[i]!;
    buf.tileUv.push(t[0], t[1]);
    buf.atlasRect.push(rect[0], rect[1], rect[2], rect[3]);
    buf.tileRot.push(rotation);
    const m = cornerMul[i]!;
    buf.col.push(color.r * m, color.g * m, color.b * m);
  }
}

/**
 * Per-corner light×AO×faceShade multipliers for a face (order = faceCorners).
 *
 * Smooth path: average combined light of the 4 blocks around each corner, then
 * AO-darken by how many of the three outer cells occlude.
 * Flat path: sample once at the face-neighbour cell.
 *
 * @param q - Emitted/merged quad in section-local coords.
 * @param d - Face direction descriptor.
 * @param light - World light context.
 * @param shade - Directional face shade.
 * @returns four multipliers in faceCorners order.
 */
function vertexLightMultipliers(
  q: MergeQuad,
  d: (typeof DIRS)[number],
  light: LightCtx,
  shade: number,
): [number, number, number, number] {
  const nx = q.x + d.dx;
  const ny = q.y + d.dy;
  const nz = q.z + d.dz;

  if (!light.smooth) {
    const level = sampleCombined(light, nx, ny, nz);
    const m = lightBrightness(level) * shade;
    return [m, m, m, m];
  }

  // UV sign per faceCorners corner index: which way from the face cell.
  const uvSigns = cornerUvSigns(d.dir, q.du, q.dv);
  const out: [number, number, number, number] = [1, 1, 1, 1];
  for (let i = 0; i < 4; i++) {
    const [su, sv] = uvSigns[i]!;
    const uOff = axisDelta(d.uAxis);
    const vOff = axisDelta(d.vAxis);
    const sx = uOff[0]! * su;
    const sy = uOff[1]! * su;
    const sz = uOff[2]! * su;
    const tx = vOff[0]! * sv;
    const ty = vOff[1]! * sv;
    const tz = vOff[2]! * sv;

    const c0 = sampleCombined(light, nx, ny, nz);
    const c1 = sampleCombined(light, nx + sx, ny + sy, nz + sz);
    const c2 = sampleCombined(light, nx + tx, ny + ty, nz + tz);
    const c3 = sampleCombined(light, nx + sx + tx, ny + sy + ty, nz + sz + tz);
    const avg = (c0 + c1 + c2 + c3) * 0.25;

    const o1 = cellOccludes(light, nx + sx, ny + sy, nz + sz);
    const o2 = cellOccludes(light, nx + tx, ny + ty, nz + tz);
    const o3 = cellOccludes(light, nx + sx + tx, ny + sy + ty, nz + sz + tz);
    const ao = q.skipAo ? 1 : aoFactor(o1, o2, o3);
    out[i] = lightBrightness(avg) * ao * shade;
  }
  return out;
}

/**
 * Emit one custom-geometry triangle into terrain atlas buffers.
 *
 * @param buf - Target buffers.
 * @param tri - World-space triangle.
 * @param lx - Section-local X (lighting).
 * @param ly - Section-local Y.
 * @param lz - Section-local Z.
 * @param emission - light_emission 0..1.
 * @param tick - Snapshot tick (flipbook).
 * @param atlas - Terrain atlas.
 * @param light - Light context.
 */
function pushCustomTri(
  buf: MeshBuffers,
  tri: CustomBlockTri,
  lx: number,
  ly: number,
  lz: number,
  emission: number,
  tick: number,
  atlas: TerrainAtlas,
  light: LightCtx,
): void {
  const uv = atlas.uvFor(tri.texture, tick, lx, ly, lz);
  const rect: [number, number, number, number] = [
    Math.min(uv.u0, uv.u1),
    Math.min(uv.v0, uv.v1),
    Math.abs(uv.u1 - uv.u0),
    Math.abs(uv.v1 - uv.v0),
  ];
  const shade = tri.faceDimming ? (FACE_SHADE[tri.dir] ?? 1) : 1;
  const level = sampleCombined(light, lx, ly, lz);
  let bright = lightBrightness(level) * shade;
  if (emission > 0) bright = Math.max(bright, Math.min(1, emission));
  for (let i = 0; i < 3; i++) {
    buf.pos.push(
      tri.positions[i * 3]!,
      tri.positions[i * 3 + 1]!,
      tri.positions[i * 3 + 2]!,
    );
    // Geometry UVs are 0..1 over the texture; feed as tile UV with unit rect.
    buf.tileUv.push(tri.uvs[i * 2]!, tri.uvs[i * 2 + 1]!);
    buf.atlasRect.push(rect[0], rect[1], rect[2], rect[3]);
    buf.tileRot.push(0);
    buf.col.push(bright, bright, bright);
  }
}

/**
 * UV corner signs matching {@link faceCorners} / {@link tileCornersForDir}.
 * Values are −1 (toward u/v=0 edge) or +1 (toward u/v=du/dv edge), relative
 * to the face-neighbour cell — for unit faces du=dv=1 this is ±1 toward the
 * adjacent column along that axis.
 *
 * @param dir - Face direction.
 * @param du - Merged size along U (only unit faces used with smooth lighting).
 * @param dv - Merged size along V.
 * @returns four `[su,sv]` pairs.
 */
function cornerUvSigns(
  dir: Dir,
  du: number,
  dv: number,
): Array<[number, number]> {
  // Signs point from the face-neighbour cell toward each corner's outer sides.
  // For a unit face the neighbour sits on the face; corners need −1 toward the
  // block's low-U/V edges and +0/+du toward high — use −1 / +1 with the high
  // side meaning "into the next cell past the high edge".
  void du;
  void dv;
  if (dir === 2) {
    // +Y corners: (0,0),(0,dv),(du,dv),(du,0) in (u,v)=(x,z)
    return [
      [-1, -1],
      [-1, 1],
      [1, 1],
      [1, -1],
    ];
  }
  if (dir === 3) {
    // -Y: (0,0),(du,0),(du,dv),(0,dv)
    return [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
  }
  // Sides: (u0,v0),(u1,v0),(u1,v1),(u0,v1)
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
}

/**
 * Sample combined light at a section-local neighbour coordinate.
 *
 * @param light - Context.
 * @param lx - Local X (may be outside 0..15).
 * @param ly - Local Y.
 * @param lz - Local Z.
 * @returns combined level 0..15.
 */
function sampleCombined(
  light: LightCtx,
  lx: number,
  ly: number,
  lz: number,
): number {
  const { sky, block } = neighbourLight(
    light.state,
    light.cx,
    light.cz,
    light.sy,
    lx,
    ly,
    lz,
  );
  return combinedLight(sky, block, light.skyDarken);
}

/**
 * Whether the cell at a local neighbour coordinate occludes for AO.
 *
 * @param light - Context.
 * @param lx - Local X.
 * @param ly - Local Y.
 * @param lz - Local Z.
 * @returns true when an opaque block occupies the cell.
 */
function cellOccludes(
  light: LightCtx,
  lx: number,
  ly: number,
  lz: number,
): boolean {
  const b = neighbourBlock(
    light.state,
    light.cx,
    light.cz,
    light.sy,
    lx,
    ly,
    lz,
  );
  if (!b || isAir(b)) return false;
  return light.resolver.occludes(b);
}

/**
 * Sky/block light at a neighbour cell. Missing/requested → sky 15, block 0.
 *
 * @param state - World.
 * @param cx - Column X.
 * @param cz - Column Z.
 * @param sy - Section Y.
 * @param lx - Local neighbour X (may be outside 0..15).
 * @param ly - Local neighbour Y.
 * @param lz - Local neighbour Z.
 * @returns sky and block levels.
 */
export function neighbourLight(
  state: WorldState,
  cx: number,
  cz: number,
  sy: number,
  lx: number,
  ly: number,
  lz: number,
): { sky: number; block: number } {
  let ncx = cx;
  let ncz = cz;
  let nsy = sy;
  let x = lx;
  let y = ly;
  let z = lz;
  if (x < 0) {
    ncx--;
    x = 15;
  } else if (x > 15) {
    ncx++;
    x = 0;
  }
  if (y < 0) {
    nsy--;
    y = 15;
  } else if (y > 15) {
    nsy++;
    y = 0;
  }
  if (z < 0) {
    ncz--;
    z = 15;
  } else if (z > 15) {
    ncz++;
    z = 0;
  }

  const col = state.columns.get(columnKey(ncx, ncz));
  if (!col || col.state === "requested") return { sky: 15, block: 0 };
  const sec = col.sections.get(nsy);
  if (!sec) return { sky: 15, block: 0 };
  const i = sectionIndex(x, y, z);
  // Tests may omit light arrays — treat as omission defaults.
  return {
    sky: sec.skyLight?.[i] ?? 15,
    block: sec.blockLight?.[i] ?? 0,
  };
}

/** Tile UV per faceCorners vertex (0..du / 0..dv in face U/V). */
function tileCornersForDir(
  dir: Dir,
  du: number,
  dv: number,
): Array<[number, number]> {
  if (dir === 2) {
    // faceCorners +Y: (0,0),(0,dv),(du,dv),(du,0) in (u,v)=(x,z)
    return [
      [0, 0],
      [0, dv],
      [du, dv],
      [du, 0],
    ];
  }
  if (dir === 3) {
    // faceCorners -Y: (0,0),(du,0),(du,dv),(0,dv)
    return [
      [0, 0],
      [du, 0],
      [du, dv],
      [0, dv],
    ];
  }
  // Side faces: corners listed as (u0,v0),(u1,v0),(u1,v1),(u0,v1)
  return [
    [0, 0],
    [du, 0],
    [du, dv],
    [0, dv],
  ];
}

/**
 * Four corners of a merged face, CCW when viewed from outside (outward normal).
 * Tile UV corners stay `[0,0],[du,0],[du,dv],[0,dv]` in this same order.
 */
function faceCorners(
  dir: Dir,
  x: number,
  y: number,
  z: number,
  du: number,
  dv: number,
  yBot: number,
  yTop: number,
): Array<[number, number, number]> {
  const vh = yBot + (yTop - yBot) * dv;
  if (dir === 0) {
    // +X east: u=+Z, v=+Y
    return [
      [x + 1, y + yBot, z],
      [x + 1, y + yBot, z + du],
      [x + 1, y + vh, z + du],
      [x + 1, y + vh, z],
    ];
  }
  if (dir === 1) {
    // -X west: u=+Z, v=+Y — CCW from -X
    return [
      [x, y + yBot, z + du],
      [x, y + yBot, z],
      [x, y + vh, z],
      [x, y + vh, z + du],
    ];
  }
  if (dir === 2) {
    // +Y up: u=+X, v=+Z — CCW from +Y (was wound -Y; culled from above)
    const yy = y + yTop;
    return [
      [x, yy, z],
      [x, yy, z + dv],
      [x + du, yy, z + dv],
      [x + du, yy, z],
    ];
  }
  if (dir === 3) {
    // -Y down: u=+X, v=+Z — CCW from -Y
    const yy = y + yBot;
    return [
      [x, yy, z],
      [x + du, yy, z],
      [x + du, yy, z + dv],
      [x, yy, z + dv],
    ];
  }
  if (dir === 4) {
    // +Z south: u=+X, v=+Y
    return [
      [x, y + yBot, z + 1],
      [x + du, y + yBot, z + 1],
      [x + du, y + vh, z + 1],
      [x, y + vh, z + 1],
    ];
  }
  // -Z north: u=+X, v=+Y — CCW from -Z
  return [
    [x + du, y + yBot, z],
    [x, y + yBot, z],
    [x, y + vh, z],
    [x + du, y + vh, z],
  ];
}

function makeMesh(
  buf: MeshBuffers,
  mat: THREE.RawShaderMaterial,
  pass: string,
): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(buf.pos, 3));
  geo.setAttribute("tileUv", new THREE.Float32BufferAttribute(buf.tileUv, 2));
  geo.setAttribute(
    "atlasRect",
    new THREE.Float32BufferAttribute(buf.atlasRect, 4),
  );
  geo.setAttribute("tileRot", new THREE.Float32BufferAttribute(buf.tileRot, 1));
  geo.setAttribute("vertColor", new THREE.Float32BufferAttribute(buf.col, 3));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.userData.pass = pass;
  return mesh;
}
