import * as THREE from "three";
import type { Mesher } from "../scene";
import type { Block } from "../protocol";
import { columnKey, sectionIndex } from "../protocol";
import type { DecodedSection, StoredColumn, WorldState } from "../store";
import { FALLBACK_TEXTURE, type TerrainAtlas } from "./atlas";
import { tintAt } from "./biome";
import { isAir, isWaterlogFluid, type BlockModelResolver } from "./resolve";
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
  private readonly atlas: TerrainAtlas;
  private readonly resolver: BlockModelResolver;
  private readonly biomeAt: BiomeAt | null;
  private readonly custom: CustomGeometryHook | null;
  private readonly texture: THREE.CanvasTexture;
  private readonly matOpaque: THREE.MeshBasicMaterial;
  private readonly matTransparent: THREE.MeshBasicMaterial;
  /** Last mesh stats (tests / debug). */
  lastStats: EmitStats = {
    quadsBeforeMerge: 0,
    quadsAfterMerge: 0,
    triangles: 0,
  };

  /**
   * @param atlas - Packed terrain atlas.
   * @param resolver - Block state → model.
   * @param opts - Optional biome lookup + custom geometry hook.
   */
  constructor(
    atlas: TerrainAtlas,
    resolver: BlockModelResolver,
    opts?: {
      biomeAt?: BiomeAt | null;
      customGeometry?: CustomGeometryHook | null;
    },
  ) {
    this.atlas = atlas;
    this.resolver = resolver;
    this.biomeAt = opts?.biomeAt ?? null;
    this.custom = opts?.customGeometry ?? null;

    this.texture = new THREE.CanvasTexture(atlas.imageSource());
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.needsUpdate = true;

    this.matOpaque = new THREE.MeshBasicMaterial({
      map: this.texture,
      vertexColors: true,
    });
    this.matTransparent = new THREE.MeshBasicMaterial({
      map: this.texture,
      vertexColors: true,
      transparent: true,
      alphaTest: 0.1,
      depthWrite: false,
    });
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

    let quadsBefore = 0;
    let instanceCount = 0;

    type FaceEmit = {
      key: string;
      pass: "opaque" | "transparent";
      dir: Dir;
      x: number;
      y: number;
      z: number;
      du: number;
      dv: number;
      uv: AtlasUv;
      color: THREE.Color;
      yTop: number;
      yBot: number;
    };

    const emits: FaceEmit[] = [];

    const blockAt = (lx: number, ly: number, lz: number): Block | undefined => {
      return neighbourBlock(state, cx, cz, sy, lx, ly, lz);
    };

    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        for (let y = 0; y < 16; y++) {
          const pi = section.indices[sectionIndex(x, y, z)]!;
          const block = section.palette[pi];
          if (!block || isAir(block)) {
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

          let exposed = false;
          const pass: "opaque" | "transparent" =
            cube.renderClass === "opaque" ? "opaque" : "transparent";

          for (const d of DIRS) {
            const nb = blockAt(x + d.dx, y + d.dy, z + d.dz);
            if (!shouldDrawFace(this.resolver, block, nb)) continue;
            exposed = true;
            quadsBefore++;
            const app = cube.faces[d.face];
            const texName = app.texture || FALLBACK_TEXTURE;
            const uv = this.atlas.uvFor(texName, tick, wx, wy, wz);
            const tint = tintAt(this.biomeAt, app.tint, wx, wz);
            const color = new THREE.Color(tint.r, tint.g, tint.b);
            const key = `${pass}|${d.dir}|${texName}|${app.tint}|${app.rotation}|${uv.u0},${uv.v0},${uv.u1},${uv.v1}`;
            emits.push({
              key,
              pass,
              dir: d.dir,
              x,
              y,
              z,
              du: 1,
              dv: 1,
              uv: rotateUv(uv, app.rotation),
              color,
              yTop: 1,
              yBot: 0,
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
            emits,
            () => {
              quadsBefore++;
            },
          );
        }
      }
    }

    // Greedy merge: group by (pass, dir, key material), then merge on face plane.
    const merged = greedyMerge(emits);
    this.lastStats = {
      quadsBeforeMerge: quadsBefore,
      quadsAfterMerge: merged.length,
      triangles: merged.length * 2,
    };

    const opaquePos: number[] = [];
    const opaqueUv: number[] = [];
    const opaqueCol: number[] = [];
    const transPos: number[] = [];
    const transUv: number[] = [];
    const transCol: number[] = [];

    for (const q of merged) {
      const d = DIRS[q.dir]!;
      const pos = q.pass === "opaque" ? opaquePos : transPos;
      const uvs = q.pass === "opaque" ? opaqueUv : transUv;
      const cols = q.pass === "opaque" ? opaqueCol : transCol;
      pushMergedQuad(pos, uvs, cols, originX, originY, originZ, q, d);
    }

    const meshes: THREE.Mesh[] = [];
    if (opaquePos.length > 0) {
      meshes.push(
        makeMesh(opaquePos, opaqueUv, opaqueCol, this.matOpaque, "opaque"),
      );
    }
    if (transPos.length > 0) {
      meshes.push(
        makeMesh(
          transPos,
          transUv,
          transCol,
          this.matTransparent,
          "transparent",
        ),
      );
    }
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
    emits: Array<{
      key: string;
      pass: "opaque" | "transparent";
      dir: Dir;
      x: number;
      y: number;
      z: number;
      du: number;
      dv: number;
      uv: AtlasUv;
      color: THREE.Color;
      yTop: number;
      yBot: number;
    }>,
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
    emits: Array<{
      key: string;
      pass: "opaque" | "transparent";
      dir: Dir;
      x: number;
      y: number;
      z: number;
      du: number;
      dv: number;
      uv: AtlasUv;
      color: THREE.Color;
      yTop: number;
      yBot: number;
    }>,
    onQuad: () => void,
  ): void {
    const model = this.resolver.resolveLiquid(block);
    if (!model) return;
    const height = liquidHeight(model.depth);
    const tint = tintAt(this.biomeAt, model.tint, wx, wz);
    const color = new THREE.Color(tint.r, tint.g, tint.b);
    const still = this.atlas.uvFor(model.textureStill, tick, wx, wy, wz);
    const flow = this.atlas.uvFor(model.textureFlow, tick, wx, wy, wz);
    const useFlow = model.flowYaw != null;
    const topUv = useFlow ? rotateUv(flow, yawToRot(model.flowYaw!)) : still;

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
        uv: topUv,
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
        uv: useFlow ? rotateUv(flow, yawToRot(model.flowYaw!)) : flow,
        color,
        yTop: height,
        yBot: 0,
      });
    }
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

function rotateUv(uv: AtlasUv, rot: 0 | 1 | 2 | 3): AtlasUv {
  if (rot === 0) return uv;
  const corners: Array<[number, number]> = [
    [uv.u0, uv.v0],
    [uv.u1, uv.v0],
    [uv.u1, uv.v1],
    [uv.u0, uv.v1],
  ];
  const r = rot % 4;
  const c0 = corners[(0 + r) % 4]!;
  const c2 = corners[(2 + r) % 4]!;
  return {
    u0: c0[0],
    v0: c0[1],
    u1: c2[0],
    v1: c2[1],
    px: uv.px,
  };
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
  color: THREE.Color;
  yTop: number;
  yBot: number;
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

function pushMergedQuad(
  pos: number[],
  uvs: number[],
  cols: number[],
  originX: number,
  originY: number,
  originZ: number,
  q: MergeQuad,
  d: (typeof DIRS)[number],
): void {
  const x0 = originX + q.x;
  const y0 = originY + q.y;
  const z0 = originZ + q.z;
  const { du, dv, uv, color, yTop, yBot } = q;

  // Build 4 corners in world space for this face direction + merge size.
  const corners = faceCorners(d.dir, x0, y0, z0, du, dv, yBot, yTop);
  // Two tris: 0,1,2  0,2,3
  const order = [0, 1, 2, 0, 2, 3];
  const uvCorners: Array<[number, number]> = [
    [uv.u0, uv.v0],
    [uv.u1, uv.v0],
    [uv.u1, uv.v1],
    [uv.u0, uv.v1],
  ];
  // Stretch UV across merge.
  const stretched: Array<[number, number]> = [
    [uv.u0, uv.v0],
    [uv.u0 + (uv.u1 - uv.u0) * du, uv.v0],
    [uv.u0 + (uv.u1 - uv.u0) * du, uv.v0 + (uv.v1 - uv.v0) * dv],
    [uv.u0, uv.v0 + (uv.v1 - uv.v0) * dv],
  ];
  void uvCorners;
  for (const i of order) {
    const c = corners[i]!;
    pos.push(c[0], c[1], c[2]);
    const t = stretched[i]!;
    uvs.push(t[0], t[1]);
    cols.push(color.r, color.g, color.b);
  }
}

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
    // +X east: u=Z, v=Y
    return [
      [x + 1, y + yBot, z],
      [x + 1, y + yBot, z + du],
      [x + 1, y + vh, z + du],
      [x + 1, y + vh, z],
    ];
  }
  if (dir === 1) {
    // -X west: u=Z, v=Y
    return [
      [x, y + yBot, z + du],
      [x, y + yBot, z],
      [x, y + vh, z],
      [x, y + vh, z + du],
    ];
  }
  if (dir === 2) {
    // +Y up: u=X, v=Z
    const yy = y + yTop;
    return [
      [x, yy, z],
      [x + du, yy, z],
      [x + du, yy, z + dv],
      [x, yy, z + dv],
    ];
  }
  if (dir === 3) {
    // -Y down: u=X, v=Z
    const yy = y + yBot;
    return [
      [x, yy, z + dv],
      [x + du, yy, z + dv],
      [x + du, yy, z],
      [x, yy, z],
    ];
  }
  if (dir === 4) {
    // +Z south: u=X, v=Y
    return [
      [x, y + yBot, z + 1],
      [x + du, y + yBot, z + 1],
      [x + du, y + vh, z + 1],
      [x, y + vh, z + 1],
    ];
  }
  // -Z north: u=X, v=Y
  return [
    [x + du, y + yBot, z],
    [x, y + yBot, z],
    [x, y + vh, z],
    [x + du, y + vh, z],
  ];
}

function makeMesh(
  pos: number[],
  uv: number[],
  col: number[],
  mat: THREE.MeshBasicMaterial,
  pass: string,
): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.userData.pass = pass;
  return mesh;
}
