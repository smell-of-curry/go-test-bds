/** Schema version every frame must carry. Mismatch → refuse to render. */
export const SCHEMA_VERSION = 1;

export type FrameType =
  "hello" | "keyframe" | "delta" | "mark" | "capture" | "chat" | "title";

export type ColumnReceiptState = "requested" | "partial" | "complete";

export type MarkPhase =
  "runStart" | "suiteStart" | "testStart" | "testEnd" | "suiteEnd" | "runEnd";

export interface Block {
  name: string;
  states: Record<string, string | number | boolean>;
  rid: number;
}

export interface Section {
  y: number;
  palette: Block[];
  /** base64 of 4096 little-endian uint16 palette indices, order (x<<8)|(z<<4)|y */
  blocks: string;
  /** layer 1 (waterlogging); absent when all air */
  blocks1?: string;
  /**
   * base64 of 2048 bytes (4096 nibbles) sky light, same index as `blocks`.
   * Even index → low nibble. Absent ⇒ every level is 15 (full sky).
   */
  skyLight?: string;
  /**
   * base64 of 2048 bytes (4096 nibbles) block light, same packing as `skyLight`.
   * Absent ⇒ every level is 0.
   */
  blockLight?: string;
}

export interface Column {
  x: number;
  z: number;
  state: ColumnReceiptState;
  minY: number;
  maxY: number;
  sections: Section[];
  /**
   * Surface biome palette entries: dragonfly names (`plains`) or numeric ids.
   * Paired with {@link biomes}; omitted on incomplete columns.
   */
  biomePalette?: Array<string | number>;
  /**
   * base64 of 256 uint8 indices into {@link biomePalette}, order `(x<<4)|z`.
   */
  biomes?: string;
  /**
   * Block entities in this column (chests, signs, …). Optional; absent on older
   * encoders. Additive — not a schema `v` bump.
   */
  blockEntities?: BlockEntityWire[];
}

/** Minimal block-entity projection for dedicated geometry (sign text, etc.). */
export interface BlockEntityWire {
  /** World block position `[x,y,z]`. */
  pos: [number, number, number];
  /** Block / tile id, e.g. `minecraft:chest` or Bedrock `Chest`. */
  id: string;
  /** Sign front lines (format codes may be present). */
  textFront?: string[];
  /** Sign back lines. */
  textBack?: string[];
}

export interface Item {
  name: string;
  count: number;
  damage?: number;
  customName?: string;
}

export interface Entity {
  rid: number;
  uid: number;
  type: string;
  pos: [number, number, number];
  /** Degrees: `[yaw, pitch]` or `[yaw, pitch, headYaw]` (see PROTOCOL.md). */
  rot: [number, number] | [number, number, number];
  vel: [number, number, number];
  bbox: [number, number];
  name: string;
  player: boolean;
  flags: Record<string, boolean>;
  props: Record<string, string | number | boolean>;
  attributes: Record<string, number>;
  held: { main: Item | null; off: Item | null };
  armour: [Item | null, Item | null, Item | null, Item | null];
}

export interface LookingAt {
  pos: [number, number, number];
  face: string;
  block: Block;
}

export interface Actor {
  rid: number;
  uid: number;
  name: string;
  pos: [number, number, number];
  eyePos: [number, number, number];
  /** Degrees: `[yaw, pitch]` or `[yaw, pitch, headYaw]` (see PROTOCOL.md). */
  rot: [number, number] | [number, number, number];
  vel: [number, number, number];
  onGround: boolean;
  gamemode: number;
  dimension: number;
  health: number;
  maxHealth: number;
  food: number;
  heldSlot: number;
  sneaking: boolean;
  sprinting: boolean;
  swimming: boolean;
  gliding: boolean;
  hotbar: (Item | null)[];
  inventory: (Item | null)[];
  offhand: Item | null;
  armour: [Item | null, Item | null, Item | null, Item | null];
  effects: { name: string; level: number; durationMs: number }[];
  chunkRadius: number;
  lookingAt?: LookingAt;
}

export interface WorldMeta {
  dimension: number;
  dimensionName: string;
  minY: number;
  maxY: number;
}

/** Server CameraInstruction override. Absent = default client camera. */
export interface CameraWire {
  preset?: string;
  pos?: [number, number, number];
  /** `[yaw, pitch]` degrees. */
  rot?: [number, number];
  easeDurationMs?: number;
  fov?: number;
  fade?: {
    fadeInSec?: number;
    waitSec?: number;
    fadeOutSec?: number;
    colour?: [number, number, number];
  };
}

export interface UI {
  form?: {
    type: string;
    title: string;
    content: string;
    buttons: string[];
  } | null;
  container?: {
    type: string;
    title: string;
    slots: (Item | null)[];
  } | null;
  sign?: { front: string[]; back: string[] } | null;
  dialogue?: { npcName: string; text: string; buttons: string[] } | null;
  messages?: string[];
  title?: string;
  subtitle?: string;
  actionBar?: string;
  /** Title fade-in duration in ticks (20ths of a second). */
  fadeInTicks?: number;
  /** Title stay duration in ticks. */
  stayTicks?: number;
  /** Title fade-out duration in ticks. */
  fadeOutTicks?: number;
}

export interface HelloFrame {
  v: number;
  type: "hello";
  bot: string;
  schema: number;
  tickRate: number;
  radius: number;
}

/** One material_instances face entry (Go `RegistryMaterial` JSON). */
export interface RegistryMaterial {
  texture?: string;
  renderMethod?: string;
  faceDimming?: boolean;
  ambientOcclusion?: boolean;
}

/** Render-relevant block components from the network palette. */
export interface RegistryComponents {
  geometry?: string;
  unitCube?: boolean;
  materialInstances?: Record<string, RegistryMaterial>;
  transformation?: RegistryTransform;
  lightEmission?: number;
  collisionBox?: RegistryBox;
  selectionBox?: RegistrySelectionBox;
  boneVisibility?: Record<string, unknown>;
}

export interface RegistryTransform {
  rx: number;
  ry: number;
  rz: number;
  sx: number;
  sy: number;
  sz: number;
  tx: number;
  ty: number;
  tz: number;
}

export interface RegistryBox {
  enabled: boolean;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface RegistrySelectionBox {
  enabled: boolean;
  origin: [number, number, number];
  size: [number, number, number];
}

export interface RegistryProp {
  name: string;
  enum?: unknown[];
}

export interface RegistryPerm {
  condition: string;
  components: RegistryComponents;
}

/** One custom block from `GameData.CustomBlocks` (keyframe `registries.blocks`). */
export interface RegistryBlock {
  name: string;
  molangVersion?: number;
  properties?: RegistryProp[];
  components: RegistryComponents;
  permutations?: RegistryPerm[];
}

export interface RegistryItem {
  name: string;
  componentBased: boolean;
  version?: number;
  icon?: string;
  components?: Record<string, unknown>;
}

export interface RegistryActorProp {
  name: string;
  type: string;
  enum?: unknown[];
  default?: unknown;
  range?: [number, number];
}

export interface RegistryActor {
  type: string;
  properties: RegistryActorProp[];
}

/**
 * Join-static registries on the keyframe (absent on deltas).
 * Field casing matches `gotestbds/viewer` JSON tags.
 */
export interface Registries {
  blocks: RegistryBlock[];
  items: RegistryItem[];
  actors: RegistryActor[];
}

export interface KeyframeFrame {
  v: number;
  type: "keyframe";
  bot: string;
  tick: number;
  world: WorldMeta;
  actor: Actor;
  columns: Column[];
  /** Columns in the stream radius not yet delivered; 0/absent = caught up. */
  columnsPending?: number;
  entities: Entity[];
  ui?: UI;
  /** Join-static custom blocks / items / actor props; omit on deltas. */
  registries?: Registries;
  /** Absolute world time ticks (SetTime). Absent = fixed noon sky. */
  time?: number;
  /** Server camera override. Absent = default client camera. */
  camera?: CameraWire;
}

export interface BlockChange {
  pos: [number, number, number];
  layer: number;
  block: Block;
}

export interface ColumnStateUpdate {
  x: number;
  z: number;
  state: ColumnReceiptState;
}

export interface DeltaFrame {
  v: number;
  type: "delta";
  bot: string;
  tick: number;
  world?: WorldMeta;
  blocks?: BlockChange[];
  columnsAdded?: Column[];
  columnsRemoved?: [number, number][];
  columnsState?: ColumnStateUpdate[];
  /** Columns in the stream radius not yet delivered; 0/absent = caught up. */
  columnsPending?: number;
  entitiesAdded?: Entity[];
  entitiesUpdated?: Entity[];
  entitiesRemoved?: number[];
  actor?: Actor;
  ui?: UI;
  /** Absolute world time when it changed. Absent = unchanged. */
  time?: number;
  /** Camera override when it changed. */
  camera?: CameraWire;
  /** True when an active override was cleared. */
  cameraCleared?: boolean;
}

export interface MarkFrame {
  v: number;
  type: "mark";
  bot: string;
  tick: number;
  phase: MarkPhase;
  runId?: string;
  suite?: string;
  test?: string;
  status?: string;
  message?: string;
  elapsedMs?: number;
}

export interface CaptureFrame {
  v: number;
  type: "capture";
  bot: string;
  id: string;
  minTick: number;
  ext: string;
  label?: string;
}

/** Event-lane chat line (never dropped for world backpressure). */
export interface ChatFrame {
  v: number;
  type: "chat";
  bot: string;
  tick: number;
  text: string;
}

/** Event-lane title / subtitle / action-bar update. */
export interface TitleFrame {
  v: number;
  type: "title";
  bot: string;
  tick: number;
  title?: string;
  subtitle?: string;
  actionBar?: string;
  fadeInTicks?: number;
  stayTicks?: number;
  fadeOutTicks?: number;
  clear?: boolean;
}

/** Event-lane particle spawn from `packet.SpawnParticleEffect`. */
export interface ParticleFrame {
  v: number;
  type: "particle";
  bot: string;
  tick: number;
  /** Effect identifier (e.g. `minecraft:basic_smoke_particle`). */
  name: string;
  /** World position (or entity-relative when `entityId` is set). */
  pos: [number, number, number];
  /** Dimension id from the packet (informational). */
  dimension?: number;
  /** Entity unique id when the position is relative; omitted / -1 = absolute. */
  entityId?: number;
}

export type Frame =
  | HelloFrame
  | KeyframeFrame
  | DeltaFrame
  | MarkFrame
  | CaptureFrame
  | ChatFrame
  | TitleFrame
  | ParticleFrame;

export function columnKey(x: number, z: number): string {
  return `${x},${z}`;
}

/**
 * Decode a section's `blocks` (or `blocks1`) base64 payload into 4096 palette indices.
 *
 * @param b64 - base64 of 4096 little-endian uint16 values.
 * @returns palette index per local cell, length 4096.
 * @throws if the decoded byte length is not exactly 8192.
 */
export function decodeSectionBlocks(b64: string): Uint16Array {
  const bin = atob(b64);
  if (bin.length !== 4096 * 2) {
    throw new Error(`section blocks length ${bin.length}, expected 8192`);
  }
  const out = new Uint16Array(4096);
  for (let i = 0; i < 4096; i++) {
    const lo = bin.charCodeAt(i * 2);
    const hi = bin.charCodeAt(i * 2 + 1);
    out[i] = lo | (hi << 8);
  }
  return out;
}

/** Local section cell index: Bedrock sub-chunk order `(x<<8)|(z<<4)|y`. */
export function sectionIndex(x: number, y: number, z: number): number {
  return (x << 8) | (z << 4) | y;
}

/**
 * Decode a section light payload (sky or block) into 4096 levels 0..15.
 * Packing matches Bedrock/dragonfly: even index in the low nibble.
 *
 * @param b64 - base64 of 2048 bytes, or undefined/empty for the omission default.
 * @param fill - Level written when the field is omitted (15 for sky, 0 for block).
 * @returns per-cell light levels, length 4096, index {@link sectionIndex}.
 * @throws if `b64` is present but not exactly 2048 decoded bytes.
 */
export function decodeSectionLight(
  b64: string | undefined,
  fill: number,
): Uint8Array {
  const out = new Uint8Array(4096);
  if (b64 == null || b64 === "") {
    out.fill(fill & 0xf);
    return out;
  }
  const bin = atob(b64);
  if (bin.length !== 2048) {
    throw new Error(`section light length ${bin.length}, expected 2048`);
  }
  for (let i = 0; i < 2048; i++) {
    const b = bin.charCodeAt(i);
    out[i * 2] = b & 0xf;
    out[i * 2 + 1] = (b >> 4) & 0xf;
  }
  return out;
}

/**
 * Decode a column surface biome index map.
 *
 * @param b64 - base64 of 256 uint8 palette indices, or undefined when omitted.
 * @returns length-256 index array, or null when absent.
 * @throws if `b64` is present but not exactly 256 decoded bytes.
 */
export function decodeColumnBiomes(b64: string | undefined): Uint8Array | null {
  if (b64 == null || b64 === "") return null;
  const bin = atob(b64);
  if (bin.length !== 256) {
    throw new Error(`column biomes length ${bin.length}, expected 256`);
  }
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Column biome cell index: `(x<<4)|z` with x,z local 0..15. */
export function biomeIndex(x: number, z: number): number {
  return (x << 4) | z;
}
