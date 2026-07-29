import { FALLBACK_TEXTURE, NEUTRAL_TEXTURE } from "./atlas";
import type { BlockGeometryCache } from "./customGeometry";
import { renderClassFromComponents } from "./customGeometry";
import {
  canonicalizeBlockId,
  expandTexturesField,
  parseBlocksJson,
  type BlocksJson,
} from "./parse";
import {
  facesFromMaterialInstances,
  indexRegistryBlocks,
  textureNamesFromRegistries,
} from "./palette";
import { effectiveComponents, materialFlags } from "./permutations";
import type {
  BlockDef,
  CubeModel,
  FaceAppearance,
  LiquidModel,
  RenderClass,
} from "./types";
import type { Block, Registries, RegistryBlock } from "../protocol";
import { blockEntityKind } from "./blockEntities";

type Cardinal = "up" | "down" | "north" | "south" | "east" | "west";

const CARDINALS: Cardinal[] = ["up", "down", "north", "south", "east", "west"];

const CUTOUT_NAMES = new Set([
  "minecraft:oak_leaves",
  "minecraft:spruce_leaves",
  "minecraft:birch_leaves",
  "minecraft:jungle_leaves",
  "minecraft:acacia_leaves",
  "minecraft:dark_oak_leaves",
  "minecraft:mangrove_leaves",
  "minecraft:cherry_leaves",
  "minecraft:azalea_leaves",
  "minecraft:flowering_azalea_leaves",
  "minecraft:glass",
  "minecraft:glass_pane",
  "minecraft:iron_bars",
]);

const TRANSLUCENT_NAMES = new Set([
  "minecraft:glass",
  "minecraft:white_stained_glass",
  "minecraft:ice",
  "minecraft:frosted_ice",
  "minecraft:slime",
  "minecraft:honey_block",
]);

const LIQUID_NAMES = new Set([
  "minecraft:water",
  "minecraft:flowing_water",
  "minecraft:lava",
  "minecraft:flowing_lava",
]);

const GRASS_TINT_FACES = new Set(["minecraft:grass_block"]);
const FOLIAGE_NAMES = new Set([
  "minecraft:oak_leaves",
  "minecraft:spruce_leaves",
  "minecraft:birch_leaves",
  "minecraft:jungle_leaves",
  "minecraft:acacia_leaves",
  "minecraft:dark_oak_leaves",
  "minecraft:vine",
]);

/**
 * Registry: blocks.json (+ optional network palette) → cube / liquid models.
 */
export class BlockModelResolver {
  private readonly blocks: BlocksJson;
  private registryByName = new Map<string, RegistryBlock>();
  private geoCache: BlockGeometryCache | null = null;

  /**
   * @param blocks - Parsed blocks.json.
   * @param registries - Optional keyframe registries (network palette).
   */
  constructor(blocks: BlocksJson, registries?: Registries | null) {
    this.blocks = blocks;
    if (registries) this.setRegistries(registries);
  }

  /**
   * Bind the geometry cache so resolve/occludes know which cells use custom meshes.
   *
   * @param cache - Preloaded block geometry cache, or null.
   */
  setGeometryCache(cache: BlockGeometryCache | null): void {
    this.geoCache = cache;
  }

  /**
   * @param raw - Raw blocks.json object.
   * @returns resolver.
   */
  static fromJson(raw: unknown): BlockModelResolver {
    return new BlockModelResolver(parseBlocksJson(raw));
  }

  /**
   * Replace the network palette index (join-static; call when keyframe arrives).
   *
   * @param registries - Keyframe registries or null to clear.
   */
  setRegistries(registries: Registries | null | undefined): void {
    this.registryByName = indexRegistryBlocks(registries ?? null);
  }

  /**
   * Collect every terrain short-name referenced by known block defs + palette.
   *
   * @returns short-name set for atlas packing.
   */
  allTextureNames(): Set<string> {
    const out = new Set<string>();
    for (const def of Object.values(this.blocks)) {
      for (const field of [def.textures, def.carried_textures]) {
        const faces = expandTexturesField(field);
        for (const v of Object.values(faces)) if (v) out.add(v);
      }
    }
    for (const n of textureNamesFromRegistries({
      blocks: [...this.registryByName.values()],
      items: [],
      actors: [],
    })) {
      out.add(n);
    }
    out.add(NEUTRAL_TEXTURE);
    // Liquids always need these keys when present in terrain_texture.
    for (const n of [
      "water_still",
      "water_flow",
      "lava_still",
      "lava_flow",
      "still_water",
      "flowing_water",
      "still_lava",
      "flowing_lava",
    ]) {
      out.add(n);
    }
    return out;
  }

  /**
   * Look up a block def, tolerating bare↔`minecraft:` key skew.
   *
   * @param name - Snapshot / network block name.
   * @returns def or undefined.
   */
  defOf(name: string): BlockDef | undefined {
    const direct = this.blocks[name];
    if (direct) return direct;
    const canon = canonicalizeBlockId(name);
    if (canon !== name) {
      const byCanon = this.blocks[canon];
      if (byCanon) return byCanon;
    }
    if (name.startsWith("minecraft:")) {
      return this.blocks[name.slice("minecraft:".length)];
    }
    return undefined;
  }

  /**
   * Classify a block for culling / passes.
   *
   * @param block - Block.
   * @returns render class.
   */
  renderClassOf(block: Block): RenderClass {
    if (isAir(block)) return "air";
    const n = block.name;
    if (LIQUID_NAMES.has(n)) return "liquid";
    if (TRANSLUCENT_NAMES.has(n) || n.includes("stained_glass"))
      return "translucent";
    if (CUTOUT_NAMES.has(n) || n.endsWith("_leaves")) return "cutout";
    // Dedicated block-entity geometry is never a full occluding cube.
    if (blockEntityKind(n)) return "cutout";

    // Palette render_method (alpha_test → cutout) when pack has no textures.
    if (!this.hasPackTextures(block.name)) {
      const reg = this.registryByName.get(n);
      if (reg) {
        const comps = effectiveComponents(reg, block.states);
        if (comps.materialInstances) {
          return renderClassFromComponents(comps);
        }
      }
    }

    if (n === "" && block.rid !== 0) return "opaque";
    return "opaque";
  }

  /**
   * Whether this block fully occludes neighbour faces (unknown-neighbour policy
   * is handled by the mesher — this is only for known cells).
   *
   * @param block - Block.
   * @returns true when opaque full cube.
   */
  occludes(block: Block | undefined): boolean {
    if (!block) return false;
    // Custom geometry / block entities are not full cubes — never occlude.
    if (this.usesCustomGeometry(block)) return false;
    if (blockEntityKind(block.name)) return false;
    const rc = this.renderClassOf(block);
    return rc === "opaque";
  }

  /**
   * @param block - Block.
   * @returns true when mesher should emit cached custom geometry.
   */
  usesCustomGeometry(block: Block): boolean {
    const reg = this.registryByName.get(block.name);
    if (!reg || !this.geoCache) return false;
    if (this.hasPackTextures(block.name)) return false;
    const comps = effectiveComponents(reg, block.states);
    if (!comps.geometry || comps.unitCube) return false;
    return this.geoCache.has(comps.geometry);
  }

  /**
   * Resolve cube face appearances for a block at a position.
   *
   * @param block - Block.
   * @param x - Block X (variation seed).
   * @param y - Block Y.
   * @param z - Block Z.
   * @returns cube model, or null for air / liquids (use {@link resolveLiquid}).
   */
  resolveCube(block: Block, x: number, y: number, z: number): CubeModel | null {
    void x;
    void y;
    void z;
    if (isAir(block)) return null;
    if (this.renderClassOf(block) === "liquid") return null;

    // Unnamed rid → magenta (bug marker).
    if (block.name === "" && block.rid !== 0) {
      return this.solidCube(FALLBACK_TEXTURE, "opaque");
    }

    // Pack textures win when present; palette covers gaps (custom blocks).
    if (this.hasPackTextures(block.name)) {
      const def = this.defOf(block.name)!;
      const faces = this.baseFaces(def, block);
      this.applyStateRemap(faces, block);
      return {
        faces,
        renderClass: this.renderClassOf(block),
        customGeometryKey: undefined,
      };
    }

    const reg = this.registryByName.get(block.name);
    if (reg) {
      const comps = effectiveComponents(reg, block.states);
      const fromMats = facesFromMaterialInstances(comps.materialInstances);
      if (fromMats) {
        const star = comps.materialInstances?.["*"];
        const flags = materialFlags(star);
        const geoId = comps.geometry;
        const useGeo =
          !!geoId && !comps.unitCube && !!this.geoCache?.has(geoId);
        return {
          faces: fromMats.faces,
          renderClass: fromMats.renderClass,
          customGeometryKey: useGeo ? geoId : undefined,
          transformation: comps.transformation,
          lightEmission: comps.lightEmission,
          faceDimming: flags.faceDimming,
          ambientOcclusion: flags.ambientOcclusion,
          boneVisibility: comps.boneVisibility,
          materialInstances: comps.materialInstances,
        };
      }
      // Palette entry without material_instances → neutral grey, not magenta.
      return this.solidCube(NEUTRAL_TEXTURE, "opaque");
    }

    // Named but unknown to pack + palette → neutral (magenta reserved for bugs).
    if (block.name !== "") {
      return this.solidCube(NEUTRAL_TEXTURE, "opaque");
    }

    return this.solidCube(FALLBACK_TEXTURE, "opaque");
  }

  /**
   * Whether blocks.json carries at least one texture short-name for this id.
   *
   * @param name - Block name.
   * @returns true when the pack path can paint faces.
   */
  hasPackTextures(name: string): boolean {
    const def = this.defOf(name);
    if (!def) return false;
    const faces = expandTexturesField(def.textures);
    return Object.values(faces).some(
      (v) => typeof v === "string" && v.length > 0,
    );
  }

  private solidCube(texture: string, renderClass: RenderClass): CubeModel {
    const faces = {} as Record<Cardinal, FaceAppearance>;
    for (const f of CARDINALS) {
      faces[f] = { texture, tint: "none", rotation: 0 };
    }
    return { faces, renderClass, customGeometryKey: undefined };
  }

  /**
   * Resolve liquid model (layer-0 liquid or layer-1 waterlogging).
   *
   * @param block - Liquid block.
   * @returns liquid model or null.
   */
  resolveLiquid(block: Block): LiquidModel | null {
    if (this.renderClassOf(block) !== "liquid" && !isWaterlogFluid(block))
      return null;
    const lava = block.name.includes("lava") || block.name === "minecraft:lava";
    const depth = liquidDepth(block);
    const flowYaw = liquidFlowYaw(block);
    return {
      textureStill: lava ? "lava_still" : "water_still",
      textureFlow: lava ? "lava_flow" : "water_flow",
      tint: lava ? "none" : "water",
      depth,
      flowYaw,
      renderClass: "liquid",
    };
  }

  private baseFaces(
    def: BlockDef | undefined,
    block: Block,
  ): Record<Cardinal, FaceAppearance> {
    const tex = expandTexturesField(def?.textures);
    const faces = {} as Record<Cardinal, FaceAppearance>;
    for (const f of CARDINALS) {
      const name = tex[f] ?? FALLBACK_TEXTURE;
      faces[f] = {
        texture: name || FALLBACK_TEXTURE,
        tint: tintFor(block, f),
        rotation: 0,
      };
    }
    // Unnamed rid-only blocks → fallback on every face (visible magenta).
    if (block.name === "" && block.rid !== 0) {
      for (const f of CARDINALS) {
        faces[f] = { texture: FALLBACK_TEXTURE, tint: "none", rotation: 0 };
      }
    }
    return faces;
  }

  /**
   * Map facing / axis / open / half / age onto face textures + UV rotation.
   *
   * @param faces - Mutable face map.
   * @param block - Block with states.
   */
  private applyStateRemap(
    faces: Record<Cardinal, FaceAppearance>,
    block: Block,
  ): void {
    const s = block.states;

    // axis=x|y|z — logs / pillars: swap side vs end textures.
    const axis = s.axis ?? s["pillar_axis"];
    if (axis === "x" || axis === "z") {
      const end = faces.up;
      const side = faces.north;
      if (axis === "x") {
        faces.east = { ...end };
        faces.west = { ...end };
        faces.up = { ...side, rotation: 1 };
        faces.down = { ...side, rotation: 1 };
        faces.north = { ...side };
        faces.south = { ...side };
      } else {
        faces.north = { ...end };
        faces.south = { ...end };
        faces.up = { ...side };
        faces.down = { ...side };
      }
    }

    // facing — directional blocks. blocks.json puts the front on `north`.
    const facing = String(s.facing ?? s.direction ?? "");
    if (
      facing &&
      (block.name.includes("furnace") ||
        block.name.includes("dispenser") ||
        block.name.includes("dropper") ||
        block.name.includes("observer") ||
        block.name.includes("pumpkin") ||
        block.name.includes("carved") ||
        block.name.endsWith("_glazed_terracotta") ||
        block.name.includes("test_directional"))
    ) {
      const frontFace = facingToFrontFace(facing);
      if (
        frontFace === "north" ||
        frontFace === "south" ||
        frontFace === "east" ||
        frontFace === "west"
      ) {
        const frontApp = faces.north;
        const sideApp = faces.east;
        for (const f of ["north", "south", "east", "west"] as const) {
          faces[f] = f === frontFace ? { ...frontApp } : { ...sideApp };
        }
      }
    }

    // open / upper-lower — doors / trapdoors: keep textures, flag via rotation.
    if (s.open === true || s.open === 1 || s.open === "true") {
      for (const f of CARDINALS) faces[f] = { ...faces[f]!, rotation: 1 };
    }
    const half = s.half ?? s.upper_block_bit;
    if (half === "upper" || half === true || half === 1) {
      // Upper door half often shares textures; no UV change required for cubes.
      void half;
    }

    // age — crops / fire: still one cube; atlas variation left to short-name.
    if (typeof s.age === "number") {
      void s.age;
    }
  }
}

/**
 * @param block - Block.
 * @returns true for air.
 */
export function isAir(block: Block | undefined): boolean {
  if (!block) return true;
  return block.name === "minecraft:air" || block.name === "air";
}

/**
 * @param block - Block.
 * @returns true when layer-1 water / lava fluid.
 */
export function isWaterlogFluid(block: Block): boolean {
  return (
    block.name === "minecraft:water" ||
    block.name === "minecraft:flowing_water" ||
    block.name === "minecraft:lava" ||
    block.name === "minecraft:flowing_lava"
  );
}

function tintFor(block: Block, face: Cardinal): FaceAppearance["tint"] {
  if (GRASS_TINT_FACES.has(block.name) && face === "up") {
    return "grass";
  }
  if (FOLIAGE_NAMES.has(block.name) || block.name.endsWith("_leaves")) {
    return "foliage";
  }
  return "none";
}

function liquidDepth(block: Block): number {
  const d = block.states.liquid_depth ?? block.states.level;
  if (typeof d === "number") return d;
  if (typeof d === "string") return Number(d) || 0;
  return 0;
}

/**
 * Bedrock liquid flow: depth 0 = source. Neighbour depths encode direction;
 * when `liquid_depth` > 0 we approximate flow toward decreasing depth via facing.
 *
 * @param block - Liquid block.
 * @returns yaw degrees or null for still.
 */
export function liquidFlowYaw(block: Block): number | null {
  const depth = liquidDepth(block);
  if (depth === 0) return null;
  const facing = block.states.facing ?? block.states.direction;
  if (facing != null) return facingToYaw(String(facing));
  // Deterministic fallback from depth so frames stay reproducible.
  return (depth % 4) * 90;
}

function facingToYaw(facing: string): number {
  switch (facing) {
    case "north":
    case "2":
      return 180;
    case "south":
    case "3":
      return 0;
    case "west":
    case "4":
      return 90;
    case "east":
    case "5":
      return 270;
    default:
      return 0;
  }
}

/**
 * Rotate N/E/S/W face appearances by yaw (0=south, 90=west, …).
 *
 * @param faces - Mutable faces.
 * @param yaw - Degrees.
 */
export function rotateYFaces(
  faces: Record<Cardinal, FaceAppearance>,
  yaw: number,
): void {
  const order: Cardinal[] = ["south", "west", "north", "east"];
  const steps = ((Math.round(yaw / 90) % 4) + 4) % 4;
  if (steps === 0) return;
  const vals = order.map((f) => faces[f]);
  for (let i = 0; i < 4; i++) {
    faces[order[i]!] = vals[(i - steps + 4) % 4]!;
  }
}

/**
 * Which face a directional block's "front" texture should land on.
 * Exported for tests.
 *
 * @param facing - State value.
 * @returns cardinal face.
 */
export function facingToFrontFace(facing: string): Cardinal {
  switch (facing) {
    case "north":
    case "2":
      return "north";
    case "south":
    case "3":
      return "south";
    case "west":
    case "4":
      return "west";
    case "east":
    case "5":
      return "east";
    case "up":
    case "1":
      return "up";
    case "down":
    case "0":
      return "down";
    default:
      return "north";
  }
}
