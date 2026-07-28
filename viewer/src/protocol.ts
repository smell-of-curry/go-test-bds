/** Schema version every frame must carry. Mismatch → refuse to render. */
export const SCHEMA_VERSION = 1;

export type FrameType = "hello" | "keyframe" | "delta" | "mark" | "capture";

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
}

export interface Column {
  x: number;
  z: number;
  state: ColumnReceiptState;
  minY: number;
  maxY: number;
  sections: Section[];
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

export type Frame =
  HelloFrame | KeyframeFrame | DeltaFrame | MarkFrame | CaptureFrame;

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
