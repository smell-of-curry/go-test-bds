import {
  type Actor,
  type Block,
  type CaptureFrame,
  type Column,
  type DeltaFrame,
  type Entity,
  type Frame,
  type HelloFrame,
  type KeyframeFrame,
  type MarkFrame,
  type UI,
  type WorldMeta,
  SCHEMA_VERSION,
  columnKey,
  decodeSectionBlocks,
  sectionIndex,
} from "./protocol";

export interface DecodedSection {
  y: number;
  /** length 4096, palette index per local cell */
  indices: Uint16Array;
  palette: Block[];
}

export interface StoredColumn {
  x: number;
  z: number;
  state: Column["state"];
  minY: number;
  maxY: number;
  sections: Map<number, DecodedSection>;
}

export interface WorldState {
  /**
   * False until a hello/keyframe with a supported schema arrives.
   * Starts false so a stuck stream is distinguishable from a missing app.
   */
  schemaOk: boolean;
  schemaError: string | null;
  hello: HelloFrame | null;
  tick: number;
  bot: string;
  world: WorldMeta | null;
  actor: Actor | null;
  columns: Map<string, StoredColumn>;
  entities: Map<number, Entity>;
  ui: UI | null;
  mark: MarkFrame | null;
  pendingCapture: CaptureFrame | null;
  /** Increments on every keyframe after the first successful one (server resync). */
  resyncCount: number;
  droppedCount: number;
  /** Frames that reached `apply` (parse already succeeded in the stream layer). */
  framesReceived: number;
  /** Monotonic revision bumped on every applied frame; scene dirty-checks against it. */
  revision: number;
  /** Section keys `"cx,cz,sy"` dirtied since last drain. */
  dirtySections: Set<string>;
  /** Column keys whose receipt-state / boundary changed. */
  dirtyColumns: Set<string>;
  /** Entity runtime IDs added/updated/removed since last drain. */
  dirtyEntities: Set<number>;
  removedEntities: Set<number>;
  /** Block positions changed since last drain (layer 0); for highlight outlines. */
  dirtyBlocks: Array<[number, number, number]>;
  /** True after a wholesale wipe (keyframe or dimension change). */
  fullReset: boolean;
}

export type StoreListener = (state: WorldState) => void;

function emptyState(): WorldState {
  return {
    schemaOk: false,
    schemaError: null,
    hello: null,
    tick: 0,
    bot: "",
    world: null,
    actor: null,
    columns: new Map(),
    entities: new Map(),
    ui: null,
    mark: null,
    pendingCapture: null,
    resyncCount: 0,
    droppedCount: 0,
    framesReceived: 0,
    revision: 0,
    dirtySections: new Set(),
    dirtyColumns: new Set(),
    dirtyEntities: new Set(),
    removedEntities: new Set(),
    dirtyBlocks: [],
    fullReset: false,
  };
}

function decodeColumn(col: Column): StoredColumn {
  const sections = new Map<number, DecodedSection>();
  // Tolerate a missing array. A nil slice on the Go side once arrived as null
  // and the throw here froze the whole viewer: no frame after it was applied,
  // for the rest of the run.
  for (const sec of col.sections ?? []) {
    sections.set(sec.y, {
      y: sec.y,
      indices: decodeSectionBlocks(sec.blocks),
      palette: sec.palette,
    });
  }
  return {
    x: col.x,
    z: col.z,
    state: col.state,
    minY: col.minY,
    maxY: col.maxY,
    sections,
  };
}

function sectionDirtyKey(cx: number, cz: number, sy: number): string {
  return `${cx},${cz},${sy}`;
}

function markAllSectionsDirty(state: WorldState, col: StoredColumn): void {
  state.dirtyColumns.add(columnKey(col.x, col.z));
  for (const sy of col.sections.keys()) {
    state.dirtySections.add(sectionDirtyKey(col.x, col.z, sy));
  }
}

/**
 * Dirty one section if it exists.
 *
 * @param state - World state whose dirty set is updated.
 * @param cx - Column X.
 * @param cz - Column Z.
 * @param sy - Section Y.
 */
function dirtySectionIfPresent(
  state: WorldState,
  cx: number,
  cz: number,
  sy: number,
): void {
  const col = state.columns.get(columnKey(cx, cz));
  if (!col?.sections.has(sy)) return;
  state.dirtySections.add(sectionDirtyKey(cx, cz, sy));
}

/**
 * Dirty sections that share a face with `(cx,cz,sy)`.
 *
 * Exposure culling looks across section/column borders, so a change on one
 * side must remesh the neighbour or shared faces stay wrong (hole or ghost).
 *
 * @param state - World state whose dirty set is updated.
 * @param cx - Column X.
 * @param cz - Column Z.
 * @param sy - Section Y.
 */
function dirtyNeighborSections(
  state: WorldState,
  cx: number,
  cz: number,
  sy: number,
): void {
  dirtySectionIfPresent(state, cx - 1, cz, sy);
  dirtySectionIfPresent(state, cx + 1, cz, sy);
  dirtySectionIfPresent(state, cx, cz - 1, sy);
  dirtySectionIfPresent(state, cx, cz + 1, sy);
  dirtySectionIfPresent(state, cx, cz, sy - 1);
  dirtySectionIfPresent(state, cx, cz, sy + 1);
}

/**
 * In-memory world model. A keyframe replaces everything; a delta with `world`
 * drops columns + entities first (dimension change).
 */
export class Store {
  private state = emptyState();
  private listeners = new Set<StoreListener>();
  private sawKeyframe = false;

  getState(): WorldState {
    return this.state;
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  apply(frame: Frame): void {
    this.state.framesReceived++;
    switch (frame.type) {
      case "hello":
        this.applyHello(frame);
        break;
      case "keyframe":
        this.applyKeyframe(frame);
        break;
      case "delta":
        this.applyDelta(frame);
        break;
      case "mark":
        this.state.mark = frame;
        this.state.tick = frame.tick;
        break;
      case "capture":
        this.state.pendingCapture = frame;
        break;
      default:
        return;
    }
    this.state.revision++;
    this.emit();
  }

  /** Clear per-frame dirty sets after the scene has drained them. */
  clearDirty(): void {
    this.state.dirtySections.clear();
    this.state.dirtyColumns.clear();
    this.state.dirtyEntities.clear();
    this.state.removedEntities.clear();
    this.state.dirtyBlocks.length = 0;
    this.state.fullReset = false;
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private applyHello(frame: HelloFrame): void {
    if (frame.v !== SCHEMA_VERSION || frame.schema !== SCHEMA_VERSION) {
      this.state.schemaOk = false;
      this.state.schemaError = `unsupported schema v=${frame.v} schema=${frame.schema} (need ${SCHEMA_VERSION})`;
      return;
    }
    this.state.schemaOk = true;
    this.state.schemaError = null;
    this.state.hello = frame;
    this.state.bot = frame.bot;
  }

  private applyKeyframe(frame: KeyframeFrame): void {
    // Keyframe carries `v` too — accept it without a prior hello so encoder-only
    // fixtures (and a hello that the client somehow missed) still become ready.
    if (frame.v !== SCHEMA_VERSION) {
      this.state.schemaOk = false;
      this.state.schemaError = `unsupported frame v=${frame.v}`;
      return;
    }
    this.state.schemaOk = true;
    this.state.schemaError = null;
    if (this.sawKeyframe) this.state.resyncCount++;
    this.sawKeyframe = true;

    this.state.columns.clear();
    this.state.entities.clear();
    this.state.dirtySections.clear();
    this.state.dirtyColumns.clear();
    this.state.dirtyEntities.clear();
    this.state.removedEntities.clear();
    this.state.dirtyBlocks.length = 0;
    this.state.fullReset = true;

    this.state.bot = frame.bot;
    this.state.tick = frame.tick;
    this.state.world = frame.world;
    this.state.actor = frame.actor;
    this.state.ui = frame.ui ?? null;

    for (const col of frame.columns) {
      const stored = decodeColumn(col);
      this.state.columns.set(columnKey(col.x, col.z), stored);
      markAllSectionsDirty(this.state, stored);
    }
    for (const ent of frame.entities) {
      this.state.entities.set(ent.rid, ent);
      this.state.dirtyEntities.add(ent.rid);
    }
  }

  private applyDelta(frame: DeltaFrame): void {
    if (!this.state.schemaOk) return;
    if (frame.v !== SCHEMA_VERSION) {
      this.state.schemaOk = false;
      this.state.schemaError = `unsupported frame v=${frame.v}`;
      return;
    }

    this.state.tick = frame.tick;
    this.state.bot = frame.bot;

    // Presence of `world` = dimension change: wipe columns + entities first.
    if (frame.world) {
      for (const rid of this.state.entities.keys()) {
        this.state.removedEntities.add(rid);
      }
      this.state.columns.clear();
      this.state.entities.clear();
      this.state.dirtySections.clear();
      this.state.dirtyColumns.clear();
      this.state.dirtyEntities.clear();
      this.state.fullReset = true;
      this.state.world = frame.world;
    }

    if (frame.actor) this.state.actor = frame.actor;
    if (frame.ui !== undefined) this.state.ui = frame.ui ?? null;

    if (frame.columnsRemoved) {
      for (const [x, z] of frame.columnsRemoved) {
        const key = columnKey(x, z);
        const existing = this.state.columns.get(key);
        if (!existing) continue;
        for (const sy of existing.sections.keys()) {
          this.state.dirtySections.add(sectionDirtyKey(x, z, sy));
          // Neighbours regain an exposed face where this column used to sit.
          dirtyNeighborSections(this.state, x, z, sy);
        }
        this.state.dirtyColumns.add(key);
        this.state.columns.delete(key);
      }
    }

    if (frame.columnsAdded) {
      for (const col of frame.columnsAdded) {
        const stored = decodeColumn(col);
        this.state.columns.set(columnKey(col.x, col.z), stored);
        markAllSectionsDirty(this.state, stored);
        // Existing neighbours may have drawn an "edge of known data" face
        // that is now buried against this column.
        for (const sy of stored.sections.keys()) {
          dirtyNeighborSections(this.state, stored.x, stored.z, sy);
        }
      }
    }

    if (frame.columnsState) {
      for (const upd of frame.columnsState) {
        const col = this.state.columns.get(columnKey(upd.x, upd.z));
        if (!col) continue;
        col.state = upd.state;
        this.state.dirtyColumns.add(columnKey(upd.x, upd.z));
      }
    }

    if (frame.blocks) {
      for (const change of frame.blocks) {
        if (change.layer !== 0) continue; // stage 2 meshes layer 0 only
        this.applyBlockChange(change.pos, change.block);
      }
    }

    if (frame.entitiesRemoved) {
      for (const rid of frame.entitiesRemoved) {
        if (this.state.entities.delete(rid)) {
          this.state.removedEntities.add(rid);
          this.state.dirtyEntities.delete(rid);
        }
      }
    }

    if (frame.entitiesAdded) {
      for (const ent of frame.entitiesAdded) {
        this.state.entities.set(ent.rid, ent);
        this.state.dirtyEntities.add(ent.rid);
        this.state.removedEntities.delete(ent.rid);
      }
    }

    if (frame.entitiesUpdated) {
      for (const ent of frame.entitiesUpdated) {
        this.state.entities.set(ent.rid, ent);
        this.state.dirtyEntities.add(ent.rid);
      }
    }
  }

  private applyBlockChange(pos: [number, number, number], block: Block): void {
    const [wx, wy, wz] = pos;
    const cx = wx >> 4;
    const cz = wz >> 4;
    const sy = wy >> 4;
    const col = this.state.columns.get(columnKey(cx, cz));
    if (!col) return;

    let sec = col.sections.get(sy);
    if (!sec) {
      // Absent section was all-air; materialising a non-air block creates it.
      sec = {
        y: sy,
        indices: new Uint16Array(4096),
        palette: [{ name: "minecraft:air", states: {}, rid: 0 }],
      };
      col.sections.set(sy, sec);
    }

    const lx = wx & 15;
    const ly = wy & 15;
    const lz = wz & 15;
    let paletteIndex = findPaletteIndex(sec.palette, block);
    if (paletteIndex < 0) {
      sec.palette = [...sec.palette, block];
      paletteIndex = sec.palette.length - 1;
    }
    sec.indices[sectionIndex(lx, ly, lz)] = paletteIndex;
    this.state.dirtySections.add(sectionDirtyKey(cx, cz, sy));
    this.state.dirtyBlocks.push([wx, wy, wz]);
    // Edge cells change the neighbour section's exposure too.
    if (lx === 0) dirtySectionIfPresent(this.state, cx - 1, cz, sy);
    if (lx === 15) dirtySectionIfPresent(this.state, cx + 1, cz, sy);
    if (ly === 0) dirtySectionIfPresent(this.state, cx, cz, sy - 1);
    if (ly === 15) dirtySectionIfPresent(this.state, cx, cz, sy + 1);
    if (lz === 0) dirtySectionIfPresent(this.state, cx, cz - 1, sy);
    if (lz === 15) dirtySectionIfPresent(this.state, cx, cz + 1, sy);
  }
}

function findPaletteIndex(palette: Block[], block: Block): number {
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i]!;
    if (
      p.name === block.name &&
      p.rid === block.rid &&
      statesEqual(p.states, block.states)
    ) {
      return i;
    }
  }
  return -1;
}

function statesEqual(
  a: Record<string, string | number | boolean>,
  b: Record<string, string | number | boolean>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
