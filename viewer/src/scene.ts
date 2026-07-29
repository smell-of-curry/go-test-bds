import * as THREE from "three";
import type { CameraController } from "./camera";
import {
  addLocomotionPoses,
  applyBonePoses,
  applyEntityYaw,
  buildItemSprite,
  createLocomotion,
  createNameTag,
  EntityAnimator,
  nameTagAnchor,
  pickBone,
  poseHeldItem,
  selectArmourLayers,
  selectHeldItem,
  tickDroppedItem,
  tickLocomotion,
  type BoneAnimPose,
  type BuiltEntityModel,
  type EntityModelRegistry,
  type ItemSprite,
  type LocomotionState,
  type NameTagSprite,
} from "./entity";
import type { ParticleSystem } from "./particles";
import type { Block, Entity } from "./protocol";
import { columnKey, sectionIndex } from "./protocol";
import type { DecodedSection, StoredColumn, WorldState } from "./store";
import {
  dayCount,
  moonDirection,
  moonPhase,
  NOON_HORIZON,
  NOON_ZENITH,
  skyPaletteAt,
  starFieldPositions,
  sunDirection,
  ticksOfDay,
} from "./sky";

/** Soft budget for remeshing work per animation frame (ms). */
export const REMESH_BUDGET_MS = 4;

/** Soft cap on sections remeshed in a single frame, even if budget remains. */
export const REMESH_MAX_SECTIONS_PER_FRAME = 8;

/** How long a block-change outline stays visible (ms). */
export const HIGHLIGHT_FADE_MS = 1000;

/** Cap live block outlines so a bulk delta cannot swamp the frame. */
export const HIGHLIGHT_MAX = 48;

/**
 * Clear colour while the pack atlas is still loading. Dark on purpose so a
 * capture never looks like a half-meshed world of coloured placeholders.
 */
export const LOADING_CLEAR = 0x0b0e14;

/**
 * Horizon band of the gradient sky dome (also fog colour).
 * Matches noon keyframe — used when snapshot `time` is absent.
 */
export const SKY_HORIZON = NOON_HORIZON;

/** Zenith colour of the gradient sky dome (fixed noon when time absent). */
export const SKY_ZENITH = NOON_ZENITH;

/**
 * @deprecated Prefer {@link SKY_HORIZON}; kept so older call sites compile.
 * `setClearColor(SKY_CLEAR)` now enables the gradient sky + fog.
 */
export const SKY_CLEAR = SKY_HORIZON;

export interface Mesher {
  /**
   * Build placeholder geometry for one section.
   *
   * @param section - Decoded section (palette + indices).
   * @param column - Parent column (for world origin).
   * @param state - World state for cross-section neighbour lookups.
   * @returns Meshes keyed by block identity, plus culled block-instance count.
   */
  meshSection(
    section: DecodedSection,
    column: StoredColumn,
    state: WorldState,
  ): { meshes: THREE.Mesh[]; instanceCount: number };
}

/** Unit-face quads (two tris) in local block space, centred on the cube. */
const FACE_QUADS: ReadonlyArray<{
  dx: number;
  dy: number;
  dz: number;
  verts: ReadonlyArray<readonly [number, number, number]>;
}> = [
  {
    dx: 1,
    dy: 0,
    dz: 0,
    verts: [
      [0.5, -0.5, -0.5],
      [0.5, -0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.5, -0.5, -0.5],
      [0.5, 0.5, 0.5],
      [0.5, 0.5, -0.5],
    ],
  },
  {
    dx: -1,
    dy: 0,
    dz: 0,
    verts: [
      [-0.5, -0.5, 0.5],
      [-0.5, -0.5, -0.5],
      [-0.5, 0.5, -0.5],
      [-0.5, -0.5, 0.5],
      [-0.5, 0.5, -0.5],
      [-0.5, 0.5, 0.5],
    ],
  },
  {
    dx: 0,
    dy: 1,
    dz: 0,
    verts: [
      [-0.5, 0.5, -0.5],
      [0.5, 0.5, -0.5],
      [0.5, 0.5, 0.5],
      [-0.5, 0.5, -0.5],
      [0.5, 0.5, 0.5],
      [-0.5, 0.5, 0.5],
    ],
  },
  {
    dx: 0,
    dy: -1,
    dz: 0,
    verts: [
      [-0.5, -0.5, 0.5],
      [0.5, -0.5, 0.5],
      [0.5, -0.5, -0.5],
      [-0.5, -0.5, 0.5],
      [0.5, -0.5, -0.5],
      [-0.5, -0.5, -0.5],
    ],
  },
  {
    dx: 0,
    dy: 0,
    dz: 1,
    verts: [
      [-0.5, -0.5, 0.5],
      [-0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [-0.5, -0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.5, -0.5, 0.5],
    ],
  },
  {
    dx: 0,
    dy: 0,
    dz: -1,
    verts: [
      [0.5, -0.5, -0.5],
      [0.5, 0.5, -0.5],
      [-0.5, 0.5, -0.5],
      [0.5, -0.5, -0.5],
      [-0.5, 0.5, -0.5],
      [-0.5, -0.5, -0.5],
    ],
  },
];

function blockKey(block: Block): string {
  if (block.name === "" && block.rid !== 0) return `rid:${block.rid}`;
  return `${block.name}|${stableStates(block.states)}|${block.rid}`;
}

function stableStates(
  states: Record<string, string | number | boolean>,
): string {
  const keys = Object.keys(states).sort();
  return keys.map((k) => `${k}=${String(states[k])}`).join(",");
}

/**
 * Deterministic colour from the block identifier. Unnamed non-zero-rid blocks
 * get hot magenta so a registry miss is never a silent grey cube.
 */
export function colorForBlock(block: Block): THREE.Color {
  if (block.name === "" && block.rid !== 0) {
    return new THREE.Color(0xff00ff);
  }
  const s = block.name + "|" + stableStates(block.states);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return new THREE.Color().setHSL(hue / 360, 0.62, 0.52);
}

function isOpaque(block: Block | undefined): boolean {
  if (!block) return false;
  if (block.name === "minecraft:air" || block.name === "air") return false;
  // Unnamed-but-present still occludes; absent palette entries do not.
  return block.name !== "" || block.rid !== 0;
}

/**
 * Whether the block at a world-local neighbour offsets the given cell.
 *
 * Unknown neighbour policy: a missing/requested column is treated as **not
 * opaque** (exposed). That draws the outer shell of loaded data — wrong the
 * other way hides the frontier until neighbours arrive. When the neighbour
 * later lands, the store dirties both sides so shared faces get culled.
 * An absent section inside a known column is all-air (same as the store).
 *
 * @param state - World columns.
 * @param cx - Column X of the cell being meshed.
 * @param cz - Column Z of the cell being meshed.
 * @param sy - Section Y of the cell being meshed.
 * @param lx - Local X of the neighbour (may be outside 0..15).
 * @param ly - Local Y of the neighbour (may be outside 0..15).
 * @param lz - Local Z of the neighbour (may be outside 0..15).
 * @returns true when the neighbour cell is known opaque.
 */
function neighbourOpaque(
  state: WorldState,
  cx: number,
  cz: number,
  sy: number,
  lx: number,
  ly: number,
  lz: number,
): boolean {
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
  // Unknown / not-yet-received column → exposed (see policy comment above).
  if (!col || col.state === "requested") return false;
  const sec = col.sections.get(nsy);
  // Known column, absent section → all air.
  if (!sec) return false;
  const idx = sec.indices[sectionIndex(x, y, z)]!;
  return isOpaque(sec.palette[idx]);
}

/**
 * Placeholder mesher: exposed faces only for non-air cells. Buried cells and
 * shared faces are skipped — required for SwiftShader capture budgets on dense
 * terrain. `instanceCount` still counts exposed *blocks* (overlay / tests).
 */
export class PlaceholderMesher implements Mesher {
  meshSection(
    section: DecodedSection,
    column: StoredColumn,
    state: WorldState,
  ): { meshes: THREE.Mesh[]; instanceCount: number } {
    const byKey = new Map<string, { block: Block; positions: number[] }>();
    const originX = column.x * 16;
    const originZ = column.z * 16;
    const originY = section.y * 16;
    const cx = column.x;
    const cz = column.z;
    const sy = section.y;
    let instanceCount = 0;

    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        for (let y = 0; y < 16; y++) {
          const pi = section.indices[sectionIndex(x, y, z)]!;
          const block = section.palette[pi];
          if (!block || !isOpaque(block)) continue;

          const cxw = originX + x + 0.5;
          const cyw = originY + y + 0.5;
          const czw = originZ + z + 0.5;
          let exposed = false;

          for (const face of FACE_QUADS) {
            if (
              neighbourOpaque(
                state,
                cx,
                cz,
                sy,
                x + face.dx,
                y + face.dy,
                z + face.dz,
              )
            ) {
              continue;
            }
            exposed = true;
            const key = blockKey(block);
            let bucket = byKey.get(key);
            if (!bucket) {
              bucket = { block, positions: [] };
              byKey.set(key, bucket);
            }
            for (const [vx, vy, vz] of face.verts) {
              bucket.positions.push(cxw + vx, cyw + vy, czw + vz);
            }
          }
          if (exposed) instanceCount++;
        }
      }
    }

    const meshes: THREE.Mesh[] = [];
    for (const { block, positions } of byKey.values()) {
      if (positions.length === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      // Unlit: colour-ID placeholders; survives software GL without lights.
      const mat = new THREE.MeshBasicMaterial({ color: colorForBlock(block) });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.userData.blockKey = blockKey(block);
      meshes.push(mesh);
    }
    return { meshes, instanceCount };
  }
}

interface SectionNode {
  key: string;
  group: THREE.Group;
  instanceCount: number;
  meshCount: number;
}

interface EntityNode {
  rid: number;
  group: THREE.Group;
  /** Wireframe bbox fallback (kept until a model loads; restored on failure). */
  wire: THREE.LineSegments;
  model: BuiltEntityModel | null;
  /** Stage 9 per-instance animation / Molang state. */
  animator: EntityAnimator | null;
  /** Procedural walk-cycle / arm-swing state (viewer-side). */
  loco: LocomotionState;
  /** In-flight model load token — bumped to ignore stale async results. */
  loadToken: number;
  type: string;
  /** In-scene billboard name tag (replaces DOM labels). */
  nameTag: NameTagSprite;
  /** Armour meshes reparented onto body bones (for disposal). */
  armourMeshes: THREE.Object3D[];
  /** Held / dropped item sprite. */
  itemSprite: ItemSprite | null;
  /** Cumulative seconds for dropped-item spin/bob. */
  lifeSec: number;
  /** Last equipment signature (skip redundant reloads). */
  gearKey: string;
}

interface HighlightNode {
  lines: THREE.LineSegments;
  bornMs: number;
}

/**
 * three.js scene: section InstancedMeshes + entity wire boxes + column bounds.
 */
export class ViewerScene {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  private mesher: Mesher;
  private readonly sections = new Map<string, SectionNode>();
  private readonly entities = new Map<number, EntityNode>();
  private readonly columnBounds = new Map<string, THREE.LineSegments>();
  private readonly highlights: HighlightNode[] = [];
  private readonly actorGroup: THREE.Group;
  private readonly actorWire: THREE.LineSegments;
  private actorModel: BuiltEntityModel | null = null;
  private actorLoadToken = 0;
  /** Walk-cycle state for the observed bot body. */
  private readonly actorLoco = createLocomotion();
  private lastActorPos: [number, number, number] | null = null;
  private lastActorTickMs = 0;
  private entityRegistry: EntityModelRegistry | null = null;
  private readonly pendingSections: string[] = [];
  private pendingSet = new Set<string>();
  private storeRef: WorldState | null = null;
  /** When false, world geometry stays on scene but is not drawn (loading). */
  private worldVisible = true;
  private actorWantedVisible = false;
  private skyMesh: THREE.Mesh | null = null;
  private envRadiusBlocks = 128;
  private ambientLight: THREE.AmbientLight | null = null;
  private sunLight: THREE.DirectionalLight | null = null;
  private sunMesh: THREE.Mesh | null = null;
  private moonMesh: THREE.Mesh | null = null;
  private starsPoints: THREE.Points | null = null;
  private celestialRoot: THREE.Group | null = null;
  /** Null = fixed noon look (no sun/moon/stars drawn). */
  private worldTime: number | null = null;
  private assetBaseUrl = "";
  private readonly nameTagScratch = new THREE.Vector3();
  private static readonly highlightGeo = new THREE.EdgesGeometry(
    new THREE.BoxGeometry(1.02, 1.02, 1.02),
  );

  blockInstanceCount = 0;
  sectionMeshCount = 0;
  /** Stage 11 particle runtime (set from main once constructed). */
  particles: ParticleSystem | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    /** @deprecated DOM labels retired — accepted for call-site compat. */
    _labelsRoot?: HTMLElement,
    mesher: Mesher = new PlaceholderMesher(),
  ) {
    this.mesher = mesher;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // MSAA is ruinously expensive on SwiftShader; capture runs headless w/o GPU.
      antialias: false,
      alpha: false,
      powerPreference: "default",
      // Needed so tests (and toDataURL) can read pixels after composite.
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(
      canvas.clientWidth || window.innerWidth,
      canvas.clientHeight || window.innerHeight,
      false,
    );
    // Start dark (loading). main.ts enables sky dome + fog once assets settle.
    this.scene.background = new THREE.Color(LOADING_CLEAR);

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 0.85);
    this.sunLight.position.set(0.6, 1, 0.3);
    this.scene.add(this.ambientLight, this.sunLight);

    this.actorGroup = new THREE.Group();
    this.actorGroup.visible = false;
    const actorGeo = new THREE.BoxGeometry(0.6, 1.8, 0.6);
    const actorEdges = new THREE.EdgesGeometry(actorGeo);
    this.actorWire = new THREE.LineSegments(
      actorEdges,
      new THREE.LineBasicMaterial({ color: 0x66ccff }),
    );
    this.actorWire.position.y = 0.9;
    this.actorGroup.add(this.actorWire);
    this.scene.add(this.actorGroup);
  }

  /**
   * Attach the entity model registry (pack-backed). Triggers async model loads
   * for any entities already on screen, and for the observed bot body.
   *
   * @param registry - Loaded (or loadable) registry, or null to disable.
   */
  setEntityRegistry(registry: EntityModelRegistry | null): void {
    this.entityRegistry = registry;
    if (!registry) return;
    for (const node of this.entities.values()) {
      const ent = this.storeRef?.entities.get(node.rid);
      if (ent) this.requestEntityModel(node, ent);
    }
    this.requestActorModel();
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
  }

  /**
   * Sync scene to store dirty sets. Remeshes at most a budgeted number of
   * sections per call; leftover keys stay queued.
   *
   * Entity / actor *poses* are applied from the render loop (interpolated);
   * this only upserts/removes entity nodes and queues remeshes.
   *
   * @param state - Current world state (read-only for meshing).
   * @param showActor - Actor body wireframe (follow / orbit; hidden in first-person).
   * @returns true when the dirty queue is empty.
   */
  sync(state: WorldState, showActor: boolean): boolean {
    this.storeRef = state;

    if (state.fullReset) {
      this.clearWorld();
    }

    for (const key of state.dirtyColumns) {
      const [xs, zs] = key.split(",");
      const cx = Number(xs);
      const cz = Number(zs);
      const col = state.columns.get(key);
      if (!col) {
        this.removeColumnBounds(key);
        // Drop section meshes belonging to a removed column.
        for (const sk of [...this.sections.keys()]) {
          if (sk.startsWith(`${cx},${cz},`)) this.removeSection(sk);
        }
        continue;
      }
      this.updateColumnBounds(col);
    }

    for (const key of state.dirtySections) {
      this.enqueueSection(key);
    }

    // Removed columns leave dirty section keys pointing at nothing — drop them.
    for (const key of [...this.pendingSet]) {
      const [xs, zs, ys] = key.split(",");
      const col = state.columns.get(`${xs},${zs}`);
      if (!col || col.state === "requested" || !col.sections.has(Number(ys))) {
        this.removeSection(key);
        this.dequeueSection(key);
      }
    }

    this.drainRemeshBudget(state);

    for (const rid of state.removedEntities) {
      this.removeEntity(rid);
    }
    for (const rid of state.dirtyEntities) {
      const ent = state.entities.get(rid);
      if (ent) this.upsertEntity(ent.rid, ent);
    }

    for (const pos of state.dirtyBlocks) {
      this.addBlockHighlight(pos);
    }

    this.actorWantedVisible = showActor && !!state.actor;
    this.actorGroup.visible = this.worldVisible && this.actorWantedVisible;

    this.recomputeCounts();
    return this.pendingSections.length === 0;
  }

  /** Force-drain every pending section (used by the smoke test settle path). */
  flush(state: WorldState): void {
    this.storeRef = state;
    while (this.pendingSections.length > 0) {
      this.remeshOne(state, this.pendingSections[0]!);
    }
    this.recomputeCounts();
  }

  /**
   * Place / show the observed bot body (follow and orbit; hidden in first-person).
   *
   * @param show - Whether the body is visible.
   * @param actorPos - Feet position, or null when no actor.
   * @param rot - Optional `[yaw, pitch]` degrees for the player model.
   */
  setActorVisible(
    show: boolean,
    actorPos: [number, number, number] | null,
    rot?: [number, number] | [number, number, number],
  ): void {
    if (!actorPos) {
      this.actorWantedVisible = false;
      this.actorGroup.visible = false;
      return;
    }
    this.actorGroup.position.set(actorPos[0], actorPos[1], actorPos[2]);
    if (rot && this.actorModel) {
      // Walk cycle from frame-to-frame position delta (actor vel is not
      // sampled through MotionLerp).
      const now = performance.now();
      const dtSec = this.lastActorTickMs
        ? Math.min(0.25, (now - this.lastActorTickMs) / 1000)
        : 0;
      this.lastActorTickMs = now;
      let speed = 0;
      if (this.lastActorPos && dtSec > 0) {
        speed =
          Math.hypot(
            actorPos[0] - this.lastActorPos[0],
            actorPos[2] - this.lastActorPos[2],
          ) / dtSec;
      }
      this.lastActorPos = [actorPos[0], actorPos[1], actorPos[2]];
      tickLocomotion(this.actorLoco, dtSec, speed, 0);
      const poses = new Map<string, BoneAnimPose>();
      addLocomotionPoses(this.actorLoco, this.actorModel.bones.keys(), poses);
      applyBonePoses(this.actorModel.bones, poses, rot[1] ?? 0);
      applyEntityYaw(this.actorModel.root, rot[0]);
    } else if (rot) {
      // Wireframe-only: yaw the whole actor group.
      this.actorGroup.rotation.order = "YXZ";
      this.actorGroup.rotation.y = Math.PI - THREE.MathUtils.degToRad(rot[0]);
    }
    this.actorWantedVisible = show;
    this.actorGroup.visible = this.worldVisible && show;
  }

  /**
   * Set the WebGL clear / scene background colour.
   * {@link LOADING_CLEAR} tears down sky+fog; any other value enables the
   * gradient sky dome and distance fog (Stage 10b).
   *
   * @param hex - RGB packed as `0xRRGGBB`.
   */
  setClearColor(hex: number): void {
    if (hex === LOADING_CLEAR) {
      this.setEnvironment({ enabled: false });
      this.scene.background = new THREE.Color(hex);
      return;
    }
    this.setEnvironment({ enabled: true });
  }

  /**
   * Install or remove the gradient sky dome + distance fog.
   *
   * @param opts.enabled - When false, flat loading clear (caller sets colour).
   * @param opts.radiusChunks - Stream/view radius in chunks (fog far ≈ radius×16).
   * @param opts.assetBaseUrl - Origin for `/asset/…` celestial textures.
   */
  setEnvironment(opts: {
    enabled: boolean;
    radiusChunks?: number;
    assetBaseUrl?: string;
  }): void {
    if (opts.radiusChunks != null && opts.radiusChunks > 0) {
      this.envRadiusBlocks = opts.radiusChunks * 16;
    }
    if (opts.assetBaseUrl != null) this.assetBaseUrl = opts.assetBaseUrl;
    if (!opts.enabled) {
      this.removeSkyDome();
      this.removeCelestials();
      this.scene.fog = null;
      this.applyFogToMesher(null);
      return;
    }
    this.ensureSkyDome();
    this.applySkyTime(this.worldTime);
  }

  /**
   * Drive sky colours / sun / moon / stars from absolute world time.
   * `null` restores the fixed noon gradient (no celestial meshes) so goldens
   * match Stage 10b.
   *
   * @param time - Absolute ticks from SetTime, or null.
   */
  setWorldTime(time: number | null): void {
    if (this.worldTime === time) return;
    this.worldTime = time;
    if (this.skyMesh) this.applySkyTime(time);
  }

  /**
   * Section mesh roots for follow-camera occlusion raycasts.
   *
   * @returns live terrain groups.
   */
  terrainMeshes(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const node of this.sections.values()) out.push(node.group);
    return out;
  }

  /**
   * Show or hide all world geometry (sections, entities, bounds, actor,
   * highlights). Used while the texture atlas is still loading so captures
   * never see coloured placeholder cubes.
   *
   * @param visible - Whether the world should draw.
   */
  setWorldVisible(visible: boolean): void {
    if (this.worldVisible === visible) return;
    this.worldVisible = visible;
    for (const node of this.sections.values()) node.group.visible = visible;
    for (const node of this.entities.values()) node.group.visible = visible;
    for (const lines of this.columnBounds.values()) lines.visible = visible;
    for (const h of this.highlights) h.lines.visible = visible;
    this.actorGroup.visible = visible && this.actorWantedVisible;
    for (const node of this.entities.values()) {
      if (!visible) node.nameTag.setVisible(false);
    }
  }

  /**
   * Move an existing entity node to an interpolated pose. Missing rids are ignored
   * (structure still comes from {@link sync}).
   *
   * Networked motion is lerped in {@link MotionLerp} (~inter-arrival / ~3 ticks);
   * this applies the already-smoothed sample.
   *
   * @param rid - Entity runtime ID.
   * @param pos - World position.
   * @param rot - Optional `[yaw, pitch]` degrees.
   */
  setEntityPos(
    rid: number,
    pos: [number, number, number],
    rot?: [number, number] | [number, number, number],
  ): void {
    const node = this.entities.get(rid);
    if (!node) return;
    node.group.position.set(pos[0], pos[1], pos[2]);
    if (rot && node.model) {
      this.entityRegistry?.applyPose(node.model, rot);
    } else if (rot) {
      node.group.rotation.order = "YXZ";
      node.group.rotation.y = Math.PI - THREE.MathUtils.degToRad(rot[0]);
    }
  }

  /**
   * Per-frame entity pose + Stage 9 animation. Call from the render loop with
   * motion-lerped entity samples.
   *
   * @param dtSec - Frame delta in seconds.
   * @param entities - Interpolated entity map (from {@link MotionLerp}).
   */
  tickEntities(dtSec: number, entities: Map<number, Entity>): void {
    for (const [rid, ent] of entities) {
      const node = this.entities.get(rid);
      if (!node) continue;
      node.lifeSec += dtSec;
      node.group.position.set(ent.pos[0], ent.pos[1], ent.pos[2]);
      if (ent.type === "minecraft:item" && node.itemSprite) {
        tickDroppedItem(node.itemSprite.root, node.lifeSec, 0);
      } else if (node.model) {
        // Pack animations (when bound) + procedural walk / arm swing.
        const poses: Map<string, BoneAnimPose> = node.animator
          ? node.animator.tick(dtSec, ent, null)
          : new Map();
        tickLocomotion(
          node.loco,
          dtSec,
          Math.hypot(ent.vel[0], ent.vel[2]),
          ent.swing ?? 0,
        );
        addLocomotionPoses(node.loco, node.model.bones.keys(), poses);
        applyBonePoses(node.model.bones, poses, ent.rot[1] ?? 0);
        applyEntityYaw(node.model.root, ent.rot[0]);
      } else {
        this.setEntityPos(rid, ent.pos, ent.rot);
      }
      this.syncEntityGear(node, ent);
    }
    // Stage 11 particle emitters (additive hook; null until main wires it).
    this.particles?.tick(dtSec);
  }

  /** Continue draining the remesh queue under the per-frame budget. */
  tickRemesh(state: WorldState): boolean {
    this.storeRef = state;
    this.drainRemeshBudget(state);
    this.recomputeCounts();
    return this.pendingSections.length === 0;
  }

  /**
   * Fade block-change outlines; drop expired ones.
   *
   * @param nowMs - `performance.now()` from the render loop.
   */
  tickHighlights(nowMs: number): void {
    for (let i = this.highlights.length - 1; i >= 0; i--) {
      const h = this.highlights[i]!;
      const age = nowMs - h.bornMs;
      if (age >= HIGHLIGHT_FADE_MS) {
        this.disposeHighlight(h);
        this.highlights.splice(i, 1);
        continue;
      }
      const mat = h.lines.material as THREE.LineBasicMaterial;
      mat.opacity = 1 - age / HIGHLIGHT_FADE_MS;
    }
  }

  render(camera: CameraController): void {
    this.renderer.render(this.scene, camera.perspective);
    this.updateNameTags(camera);
  }

  /**
   * Outline a block that just changed. Oldest highlights are evicted past the cap.
   *
   * @param pos - Block coordinates (integer cell).
   */
  addBlockHighlight(pos: [number, number, number]): void {
    while (this.highlights.length >= HIGHLIGHT_MAX) {
      const old = this.highlights.shift();
      if (old) this.disposeHighlight(old);
    }
    const mat = new THREE.LineBasicMaterial({
      color: 0xffee55,
      transparent: true,
      opacity: 1,
      depthTest: true,
    });
    const lines = new THREE.LineSegments(ViewerScene.highlightGeo, mat);
    lines.position.set(pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5);
    lines.name = `highlight:${pos.join(",")}`;
    lines.visible = this.worldVisible;
    this.scene.add(lines);
    this.highlights.push({ lines, bornMs: performance.now() });
  }

  private enqueueSection(key: string): void {
    if (this.pendingSet.has(key)) return;
    this.pendingSet.add(key);
    this.pendingSections.push(key);
  }

  private dequeueSection(key: string): void {
    if (!this.pendingSet.delete(key)) return;
    const i = this.pendingSections.indexOf(key);
    if (i >= 0) this.pendingSections.splice(i, 1);
  }

  private drainRemeshBudget(state: WorldState): void {
    const start = performance.now();
    let n = 0;
    while (this.pendingSections.length > 0) {
      if (n >= REMESH_MAX_SECTIONS_PER_FRAME) break;
      if (n > 0 && performance.now() - start >= REMESH_BUDGET_MS) break;
      const key = this.pendingSections[0]!;
      this.remeshOne(state, key);
      n++;
    }
  }

  private remeshOne(state: WorldState, key: string): void {
    this.dequeueSection(key);
    const [xs, zs, ys] = key.split(",");
    const cx = Number(xs);
    const cz = Number(zs);
    const sy = Number(ys);
    const col = state.columns.get(`${cx},${cz}`);
    if (!col || col.state === "requested") {
      this.removeSection(key);
      return;
    }
    const section = col.sections.get(sy);
    if (!section) {
      this.removeSection(key);
      return;
    }

    this.removeSection(key);
    const { meshes, instanceCount } = this.mesher.meshSection(
      section,
      col,
      state,
    );
    if (meshes.length === 0 && instanceCount === 0) {
      // Empty after culling — still count as a meshed section only if we keep a marker?
      // No geometry → no section node (absent air sections stay absent).
      return;
    }
    const group = new THREE.Group();
    group.name = `section:${key}`;
    group.visible = this.worldVisible;
    for (const m of meshes) group.add(m);
    this.scene.add(group);
    this.sections.set(key, {
      key,
      group,
      instanceCount,
      meshCount: meshes.length,
    });
  }

  private removeSection(key: string): void {
    const node = this.sections.get(key);
    if (!node) return;
    this.scene.remove(node.group);
    for (const child of node.group.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        for (const m of mesh.material) m.dispose();
      } else {
        mesh.material.dispose();
      }
    }
    this.sections.delete(key);
  }

  private updateColumnBounds(col: StoredColumn): void {
    const key = `${col.x},${col.z}`;
    this.removeColumnBounds(key);
    // requested → draw nothing (no bounds, no blocks).
    if (col.state === "requested") return;
    // partial → subtle wireframe so a hole is never mistaken for open void.
    // complete → no boundary chrome (geometry alone is enough).
    if (col.state !== "partial") return;

    const minY = col.minY;
    const height = col.maxY - col.minY + 1;
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(16, height, 16));
    const mat = new THREE.LineBasicMaterial({
      color: 0xffcc66,
      transparent: true,
      opacity: 0.35,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.position.set(col.x * 16 + 8, minY + height / 2, col.z * 16 + 8);
    lines.name = `colbound:${key}`;
    lines.visible = this.worldVisible;
    this.scene.add(lines);
    this.columnBounds.set(key, lines);
  }

  private removeColumnBounds(key: string): void {
    const lines = this.columnBounds.get(key);
    if (!lines) return;
    this.scene.remove(lines);
    lines.geometry.dispose();
    (lines.material as THREE.Material).dispose();
    this.columnBounds.delete(key);
  }

  private upsertEntity(rid: number, ent: Entity): void {
    let node = this.entities.get(rid);
    if (!node) {
      const group = new THREE.Group();
      group.name = `entity:${rid}`;
      const [w, h] = ent.bbox;
      const geo = new THREE.BoxGeometry(w, h, w);
      const edges = new THREE.EdgesGeometry(geo);
      const wire = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0xa0e0ff }),
      );
      wire.position.y = h / 2;
      group.add(wire);
      group.visible = this.worldVisible;
      this.scene.add(group);

      const nameTag = createNameTag();
      this.scene.add(nameTag.root);

      node = {
        rid,
        group,
        wire,
        model: null,
        animator: null,
        loco: createLocomotion(),
        loadToken: 0,
        type: ent.type,
        nameTag,
        armourMeshes: [],
        itemSprite: null,
        lifeSec: 0,
        gearKey: "",
      };
      this.entities.set(rid, node);
      // Initial pose only — subsequent poses come from motion-lerped tickEntities.
      node.group.position.set(ent.pos[0], ent.pos[1], ent.pos[2]);
      this.requestEntityModel(node, ent);
    } else if (node.type !== ent.type) {
      node.type = ent.type;
      this.clearEntityModel(node);
      this.requestEntityModel(node, ent);
    } else if (!node.model && !node.itemSprite && this.entityRegistry) {
      this.requestEntityModel(node, ent);
    }

    const [w, h] = ent.bbox;
    if (!node.model && !node.itemSprite) {
      node.group.rotation.order = "YXZ";
      node.group.rotation.y = Math.PI - THREE.MathUtils.degToRad(ent.rot[0]);
      // Resize wireframe if bbox changed.
      node.wire.geometry.dispose();
      node.wire.geometry = new THREE.EdgesGeometry(
        new THREE.BoxGeometry(w, h, w),
      );
      node.wire.position.y = h / 2;
    }
    node.nameTag.setText(ent.name || "");
    this.syncEntityGear(node, ent);
  }

  private removeEntity(rid: number): void {
    const node = this.entities.get(rid);
    if (!node) return;
    node.loadToken++;
    this.clearEntityModel(node);
    this.scene.remove(node.group);
    node.wire.geometry.dispose();
    (node.wire.material as THREE.Material).dispose();
    this.scene.remove(node.nameTag.root);
    node.nameTag.dispose();
    this.entities.delete(rid);
  }

  /**
   * Async-load a textured model; keep wireframe until it resolves.
   *
   * @param node - Entity node.
   * @param ent - Latest entity snapshot.
   */
  private requestEntityModel(node: EntityNode, ent: Entity): void {
    const registry = this.entityRegistry;
    if (!registry) return;
    const token = ++node.loadToken;

    if (ent.type === "minecraft:item") {
      const name = ent.held?.main?.name;
      if (!name) return;
      void registry.getItemTexture(name).then((tex) => {
        if (token !== node.loadToken) {
          tex?.dispose();
          return;
        }
        if (!tex) return;
        this.clearEntityModel(node);
        const sprite = buildItemSprite(tex);
        node.itemSprite = sprite;
        node.wire.visible = false;
        node.group.add(sprite.root);
        node.group.rotation.set(0, 0, 0);
      });
      return;
    }

    void registry.getModel(ent).then((model) => {
      if (token !== node.loadToken) {
        model?.dispose();
        return;
      }
      if (!model) return;
      this.clearEntityModel(node);
      node.model = model;
      node.wire.visible = false;
      node.group.add(model.root);
      // Model owns yaw; clear group yaw so we don't double-apply.
      node.group.rotation.set(0, 0, 0);
      registry.applyPose(model, ent.rot);
      node.animator = this.createAnimator(ent);
      node.gearKey = "";
      this.syncEntityGear(node, ent);
    });
  }

  /**
   * @param ent - Entity snapshot for type / props seed.
   * @returns animator or null.
   */
  private createAnimator(ent: Entity): EntityAnimator | null {
    const registry = this.entityRegistry;
    if (!registry) return null;
    const bindings = registry.getAnimationBindings(ent.type);
    if (!bindings) return null;
    if (
      Object.keys(bindings.shortNames).length === 0 &&
      bindings.scripts.animate.length === 0
    ) {
      return null;
    }
    return new EntityAnimator(bindings, {
      type: ent.type,
      player: ent.player,
      props: ent.props ?? {},
      flags: ent.flags ?? {},
    });
  }

  /**
   * @param node - Entity node.
   */
  private clearEntityModel(node: EntityNode): void {
    this.clearEntityGear(node);
    if (node.model) {
      node.group.remove(node.model.root);
      node.model.dispose();
      node.model = null;
    }
    if (node.itemSprite) {
      node.group.remove(node.itemSprite.root);
      node.itemSprite.dispose();
      node.itemSprite = null;
    }
    node.animator = null;
    node.wire.visible = true;
    node.gearKey = "";
  }

  /**
   * Attach / refresh armour layers + held-item sprite from snapshot equipment.
   *
   * @param node - Entity node.
   * @param ent - Latest entity.
   */
  private syncEntityGear(node: EntityNode, ent: Entity): void {
    if (ent.type === "minecraft:item") return;
    const registry = this.entityRegistry;
    if (!registry || !node.model) return;

    const armourKey = (ent.armour ?? []).map((s) => s?.name ?? "").join(",");
    const heldKey = ent.held?.main?.name ?? "";
    const key = `${armourKey}|${heldKey}`;
    if (key === node.gearKey) return;
    node.gearKey = key;
    const token = node.loadToken;

    void (async () => {
      this.clearEntityGear(node);
      if (token !== node.loadToken || !node.model) return;

      for (const layer of selectArmourLayers(ent.armour)) {
        const built = await registry.getLayerModel(
          layer.geometryId,
          layer.texturePath,
        );
        if (token !== node.loadToken || !node.model || !built) {
          built?.dispose();
          continue;
        }
        // Reparent armour meshes onto matching body bones (follow Stage 9 pose).
        for (const [boneName, armourBone] of built.bones) {
          const bodyBone = node.model.bones.get(boneName);
          if (!bodyBone) continue;
          for (const child of [...armourBone.children]) {
            bodyBone.add(child);
            node.armourMeshes.push(child);
          }
        }
        built.dispose();
      }

      const held = selectHeldItem(ent.held);
      if (!held || !node.model) return;
      const boneName = pickBone(node.model.bones, held.boneCandidates);
      const tex = await registry.getItemTexture(held.item.name);
      if (token !== node.loadToken || !tex || !node.model) {
        tex?.dispose();
        return;
      }
      const sprite = buildItemSprite(tex, 0.4);
      poseHeldItem(sprite.root);
      const parent = boneName
        ? (node.model.bones.get(boneName) ?? node.model.root)
        : node.model.root;
      parent.add(sprite.root);
      node.itemSprite = sprite;
    })();
  }

  /**
   * @param node - Entity node.
   */
  private clearEntityGear(node: EntityNode): void {
    // Cloned layer meshes share GPU resources with the cache — detach only.
    for (const mesh of node.armourMeshes) mesh.removeFromParent();
    node.armourMeshes = [];
    if (node.itemSprite && node.model) {
      node.itemSprite.root.removeFromParent();
      node.itemSprite.dispose();
      node.itemSprite = null;
    }
  }

  /** Load Steve player model onto the observed bot body when available. */
  private requestActorModel(): void {
    const registry = this.entityRegistry;
    if (!registry) return;
    const token = ++this.actorLoadToken;
    void registry
      .getModel({
        type: "minecraft:player",
        player: true,
        props: {},
        flags: {},
      })
      .then((model) => {
        if (token !== this.actorLoadToken) {
          model?.dispose();
          return;
        }
        if (!model) return;
        if (this.actorModel) {
          this.actorGroup.remove(this.actorModel.root);
          this.actorModel.dispose();
        }
        this.actorModel = model;
        this.actorWire.visible = false;
        this.actorGroup.rotation.set(0, 0, 0);
        this.actorGroup.add(model.root);
      });
  }

  private clearWorld(): void {
    for (const key of [...this.sections.keys()]) this.removeSection(key);
    for (const key of [...this.columnBounds.keys()])
      this.removeColumnBounds(key);
    for (const rid of [...this.entities.keys()]) this.removeEntity(rid);
    for (const h of this.highlights) this.disposeHighlight(h);
    this.highlights.length = 0;
    this.pendingSections.length = 0;
    this.pendingSet.clear();
  }

  private disposeHighlight(h: HighlightNode): void {
    this.scene.remove(h.lines);
    // Shared geometry — only dispose the material.
    (h.lines.material as THREE.Material).dispose();
  }

  private recomputeCounts(): void {
    let instances = 0;
    for (const node of this.sections.values()) instances += node.instanceCount;
    this.blockInstanceCount = instances;
    this.sectionMeshCount = this.sections.size;
  }

  /**
   * Position in-scene name-tag billboards. Hidden when empty, sneaking, or
   * world not visible.
   *
   * @param camera - Active camera controller.
   */
  private updateNameTags(camera: CameraController): void {
    const cam = camera.perspective;
    for (const node of this.entities.values()) {
      const ent = this.storeRef?.entities.get(node.rid);
      const text = ent?.name ?? "";
      const sneaking = !!ent?.flags?.sneaking;
      if (!this.worldVisible || !text || sneaking) {
        node.nameTag.setVisible(false);
        continue;
      }
      node.nameTag.setText(text);
      node.nameTag.setVisible(true);
      const h = ent?.bbox[1] ?? 1.8;
      nameTagAnchor(node.model?.bones, node.group, h, this.nameTagScratch);
      node.nameTag.update(cam, this.nameTagScratch);
    }
  }

  /** Exposed for tests that need to peek at pending remesh work. */
  get pendingRemeshCount(): number {
    return this.pendingSections.length;
  }

  get entityCount(): number {
    return this.entities.size;
  }

  get columnBoundCount(): number {
    return this.columnBounds.size;
  }

  /** Live block-change outlines (for tests). */
  get highlightCount(): number {
    return this.highlights.length;
  }

  /**
   * Swap the mesher and rebuild what is already on screen.
   *
   * Textures arrive from the pack stack after the scene is up, so the first
   * columns are meshed by whatever was available at the time. Without the
   * rebuild they would keep their placeholder geometry for the rest of the run.
   *
   * @param mesher The mesher to use from now on.
   */
  setMesher(mesher: Mesher): void {
    this.mesher = mesher;
    if (this.scene.fog instanceof THREE.Fog) {
      this.applyFogToMesher(this.scene.fog);
    }
    for (const key of [...this.sections.keys()]) {
      this.removeSection(key);
      this.enqueueSection(key);
    }
  }

  /**
   * Push fog uniforms into a textured mesher when present.
   *
   * @param fog - Active fog, or null to disable.
   */
  private applyFogToMesher(fog: THREE.Fog | null): void {
    const m = this.mesher as Mesher & {
      setFog?: (
        color: { r: number; g: number; b: number } | null,
        near?: number,
        far?: number,
      ) => void;
    };
    if (typeof m.setFog !== "function") return;
    if (!fog) {
      m.setFog(null);
      return;
    }
    m.setFog(fog.color, fog.near, fog.far);
  }

  /** Build an inward-facing sky sphere with zenith→horizon vertex colours. */
  private ensureSkyDome(): void {
    if (this.skyMesh) return;
    const geo = new THREE.SphereGeometry(800, 24, 16);
    geo.setAttribute(
      "color",
      new THREE.BufferAttribute(
        new Float32Array(geo.attributes.position!.count * 3),
        3,
      ),
    );
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.skyMesh = new THREE.Mesh(geo, mat);
    this.skyMesh.name = "sky-dome";
    this.skyMesh.frustumCulled = false;
    this.scene.add(this.skyMesh);
    this.paintSkyDome(SKY_ZENITH, SKY_HORIZON);
  }

  /**
   * Recolour sky dome vertices + fog/lights; spawn celestials only when time known.
   *
   * @param time - Absolute ticks, or null for fixed noon.
   */
  private applySkyTime(time: number | null): void {
    const far = this.envRadiusBlocks;
    if (time == null) {
      this.paintSkyDome(SKY_ZENITH, SKY_HORIZON);
      this.scene.background = new THREE.Color(SKY_ZENITH);
      const fog = new THREE.Fog(SKY_HORIZON, far * 0.5, far * 0.92);
      this.scene.fog = fog;
      this.applyFogToMesher(fog);
      if (this.ambientLight) this.ambientLight.intensity = 0.55;
      if (this.sunLight) {
        this.sunLight.intensity = 0.85;
        this.sunLight.position.set(0.6, 1, 0.3);
      }
      this.removeCelestials();
      return;
    }

    const tod = ticksOfDay(time);
    const pal = skyPaletteAt(tod);
    this.paintSkyDome(pal.zenith, pal.horizon);
    this.scene.background = new THREE.Color(pal.zenith);
    const fog = new THREE.Fog(pal.fog, far * 0.5, far * 0.92);
    this.scene.fog = fog;
    this.applyFogToMesher(fog);
    if (this.ambientLight) this.ambientLight.intensity = pal.ambient;
    const [sx, sy, sz] = sunDirection(tod);
    if (this.sunLight) {
      this.sunLight.intensity = pal.sun;
      this.sunLight.position.set(sx, sy, sz);
    }
    this.ensureCelestials();
    this.placeCelestials(time, pal.stars);
  }

  /**
   * @param zenith - Packed zenith colour.
   * @param horizon - Packed horizon colour.
   */
  private paintSkyDome(zenith: number, horizon: number): void {
    if (!this.skyMesh) return;
    const geo = this.skyMesh.geometry;
    const pos = geo.attributes.position!;
    const colAttr = geo.attributes.color as THREE.BufferAttribute;
    const zc = new THREE.Color(zenith);
    const hc = new THREE.Color(horizon);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const ny = pos.getY(i) / 800;
      const blend = Math.min(1, Math.max(0, (ny + 0.15) / 1.15));
      tmp.copy(hc).lerp(zc, blend);
      colAttr.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    colAttr.needsUpdate = true;
  }

  private ensureCelestials(): void {
    if (this.celestialRoot) return;
    const root = new THREE.Group();
    root.name = "celestials";
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xfff2a8,
      transparent: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    const moonMat = new THREE.MeshBasicMaterial({
      color: 0xe8e8f0,
      transparent: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    this.sunMesh = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), sunMat);
    this.moonMesh = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), moonMat);
    this.sunMesh.frustumCulled = false;
    this.moonMesh.frustumCulled = false;
    root.add(this.sunMesh, this.moonMesh);

    const starPos = starFieldPositions(400);
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    // Scale out to sky radius.
    const arr = starGeo.attributes.position!.array as Float32Array;
    for (let i = 0; i < arr.length; i++) arr[i]! *= 780;
    this.starsPoints = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({
        color: 0xffffff,
        size: 2.5,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
      }),
    );
    this.starsPoints.frustumCulled = false;
    root.add(this.starsPoints);
    this.scene.add(root);
    this.celestialRoot = root;

    // Best-effort pack textures; solid colour fallbacks stay if 404.
    const base = this.assetBaseUrl.replace(/\/$/, "");
    if (base) {
      const loader = new THREE.TextureLoader();
      loader.load(
        `${base}/asset/textures/environment/sun.png`,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          if (this.sunMesh) {
            const m = this.sunMesh.material as THREE.MeshBasicMaterial;
            m.map = tex;
            m.color.set(0xffffff);
            m.needsUpdate = true;
          }
        },
        undefined,
        () => undefined,
      );
      loader.load(
        `${base}/asset/textures/environment/moon_phases.png`,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          if (this.moonMesh) {
            const m = this.moonMesh.material as THREE.MeshBasicMaterial;
            m.map = tex;
            m.color.set(0xffffff);
            m.needsUpdate = true;
          }
        },
        undefined,
        () => undefined,
      );
    }
  }

  /**
   * @param time - Absolute world ticks.
   * @param starOpacity - 0..1.
   */
  private placeCelestials(time: number, starOpacity: number): void {
    if (!this.celestialRoot) return;
    const tod = ticksOfDay(time);
    const [sx, sy, sz] = sunDirection(tod);
    const [mx, my, mz] = moonDirection(tod);
    const R = 700;
    if (this.sunMesh) {
      this.sunMesh.position.set(sx * R, sy * R, sz * R);
      this.sunMesh.lookAt(0, 0, 0);
      this.sunMesh.visible = sy > -0.05;
    }
    if (this.moonMesh) {
      this.moonMesh.position.set(mx * R, my * R, mz * R);
      this.moonMesh.lookAt(0, 0, 0);
      this.moonMesh.visible = my > -0.05;
      const phase = moonPhase(dayCount(time));
      const mat = this.moonMesh.material as THREE.MeshBasicMaterial;
      if (mat.map) {
        // moon_phases.png is typically 4×2 tiles.
        mat.map.repeat.set(0.25, 0.5);
        mat.map.offset.set((phase % 4) * 0.25, phase < 4 ? 0.5 : 0);
        mat.map.needsUpdate = true;
      }
    }
    if (this.starsPoints) {
      const mat = this.starsPoints.material as THREE.PointsMaterial;
      mat.opacity = starOpacity;
      this.starsPoints.visible = starOpacity > 0.01;
    }
  }

  private removeCelestials(): void {
    if (!this.celestialRoot) return;
    this.scene.remove(this.celestialRoot);
    this.celestialRoot.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.celestialRoot = null;
    this.sunMesh = null;
    this.moonMesh = null;
    this.starsPoints = null;
  }

  private removeSkyDome(): void {
    if (!this.skyMesh) return;
    this.scene.remove(this.skyMesh);
    this.skyMesh.geometry.dispose();
    (this.skyMesh.material as THREE.Material).dispose();
    this.skyMesh = null;
  }

  /** Re-queue every live section (unused today; handy if mesher settings change). */
  remeshAll(): void {
    if (!this.storeRef) return;
    for (const [key, col] of this.storeRef.columns) {
      if (col.state === "requested") continue;
      const [xs, zs] = key.split(",");
      for (const sy of col.sections.keys()) {
        this.enqueueSection(`${xs},${zs},${sy}`);
      }
    }
  }
}
