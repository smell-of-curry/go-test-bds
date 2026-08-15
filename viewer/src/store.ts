import {
  type Actor,
  type Block,
  type CaptureFrame,
  type CameraWire,
  type ChatFrame,
  type BlockEntityWire,
  type Column,
  type DeltaFrame,
  type Entity,
  type FormHoverFrame,
  type Frame,
  type HelloFrame,
  type KeyframeFrame,
  type MarkFrame,
  type ParticleFrame,
  type PhudFrame,
  type Registries,
  type TitleFrame,
  type UI,
  type VitalsFrame,
  type WorldMeta,
  SCHEMA_VERSION,
  columnKey,
  decodeColumnBiomes,
  decodeSectionBlocks,
  decodeSectionLight,
  sectionIndex,
} from "./protocol";

export interface DecodedSection {
  y: number;
  /** length 4096, palette index per local cell */
  indices: Uint16Array;
  palette: Block[];
  /** length 4096 sky light 0..15 (omission default: all 15) */
  skyLight: Uint8Array;
  /** length 4096 block light 0..15 (omission default: all 0) */
  blockLight: Uint8Array;
}

export interface StoredColumn {
  x: number;
  z: number;
  state: Column["state"];
  minY: number;
  maxY: number;
  sections: Map<number, DecodedSection>;
  /** Wire biome palette (names or numeric ids); empty when omitted. */
  biomePalette: Array<string | number>;
  /** length 256 surface biome indices, or null when omitted. */
  biomeIndices: Uint8Array | null;
  /** Dedicated-geometry block entities in this column. */
  blockEntities: BlockEntityWire[];
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
  /** Join-static registries from the last keyframe; null until one arrives. */
  registries: Registries | null;
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
  /** Pending `particle` event-lane spawns since last drain. */
  pendingParticles: ParticleFrame[];
  /** True after a wholesale wipe (keyframe or dimension change). */
  fullReset: boolean;
  /**
   * Absolute world time ticks when SetTime was received. Null = fixed noon
   * sky (Stage 10b goldens unchanged).
   */
  time: number | null;
  /** Server camera override; null = default follow / first-person. */
  camera: CameraWire | null;
  /**
   * Latest raw PHUD token values from the `phud` event lane
   * (`&_<token>:<value>` SetTitle writes). `""` = element cleared/hidden.
   */
  phud: Map<string, string>;
  /**
   * Button index being visually hovered on the open form, or null. Cleared
   * whenever the form changes or closes.
   */
  formHover: number | null;
  /**
   * Latest bot survival HUD stats from the `vitals` event lane, or null until
   * the first frame (attach replay or change emit).
   */
  vitals: VitalsFrame | null;
  /**
   * Active waypoint mark (`phase: "waypoint"`, message `x,y,z|label`), or
   * null after a `clear` message. Kept off `mark` so the caption band ignores
   * it.
   */
  waypoint: MarkFrame | null;
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
    registries: null,
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
    pendingParticles: [],
    fullReset: false,
    time: null,
    camera: null,
    phud: new Map(),
    formHover: null,
    vitals: null,
    waypoint: null,
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
      skyLight: decodeSectionLight(sec.skyLight, 15),
      blockLight: decodeSectionLight(sec.blockLight, 0),
    });
  }
  return {
    x: col.x,
    z: col.z,
    state: col.state,
    minY: col.minY,
    maxY: col.maxY,
    sections,
    biomePalette: col.biomePalette ? [...col.biomePalette] : [],
    biomeIndices: decodeColumnBiomes(col.biomes),
    blockEntities: col.blockEntities ? [...col.blockEntities] : [],
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
        // Waypoint marks are a HUD channel (locator-bar strip), not run
        // lifecycle — routing them into `mark` would hijack the caption band.
        if (frame.phase === "waypoint") {
          this.state.waypoint = frame.message === "clear" ? null : frame;
          this.state.tick = frame.tick;
          break;
        }
        this.state.mark = frame;
        this.state.tick = frame.tick;
        break;
      case "capture":
        this.state.pendingCapture = frame;
        break;
      case "chat":
        this.applyChat(frame);
        break;
      case "title":
        this.applyTitle(frame);
        break;
      case "particle":
        this.applyParticle(frame);
        break;
      case "phud":
        this.applyPhud(frame);
        break;
      case "formHover":
        this.applyFormHover(frame);
        break;
      case "vitals":
        this.applyVitals(frame);
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
    this.state.pendingParticles.length = 0;
    this.state.fullReset = false;
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  /**
   * Append a chat event onto `ui.messages` (cap 20, oldest dropped).
   *
   * @param frame - Event-lane chat frame.
   */
  private applyChat(frame: ChatFrame): void {
    this.state.tick = frame.tick;
    const ui: UI = { ...(this.state.ui ?? {}) };
    const msgs = [...(ui.messages ?? []), frame.text];
    while (msgs.length > 20) msgs.shift();
    ui.messages = msgs;
    this.state.ui = ui;
  }

  /**
   * Queue a particle spawn from the event lane.
   *
   * @param frame - Event-lane particle frame.
   */
  private applyParticle(frame: ParticleFrame): void {
    this.state.tick = frame.tick;
    this.state.pendingParticles.push(frame);
  }

  /**
   * Record the latest value for a raw PHUD token.
   *
   * @param frame - Event-lane phud frame.
   */
  private applyPhud(frame: PhudFrame): void {
    this.state.tick = frame.tick;
    // Completion card holds ~4s on the server then clears. Capture stills that
    // reconnect or drain a late clear mid-wait would otherwise shoot empty —
    // keep the last non-empty loadingScreen briefly so showcase-07 can paint.
    if (
      frame.token === "loadingScreen" &&
      !frame.value &&
      (this.state.phud.get("loadingScreen") ?? "")
    ) {
      const prev = this.state.phud.get("loadingScreen") ?? "";
      window.setTimeout(() => {
        if ((this.state.phud.get("loadingScreen") ?? "") === prev) {
          this.state.phud.set("loadingScreen", "");
          this.state.revision++;
          this.emit();
        }
      }, 2500);
      return;
    }
    this.state.phud.set(frame.token, frame.value);
  }

  /**
   * Record the hovered form-button index.
   *
   * @param frame - Event-lane formHover frame.
   */
  private applyFormHover(frame: FormHoverFrame): void {
    this.state.tick = frame.tick;
    this.state.formHover = frame.index;
  }

  /**
   * Replace the latest survival HUD snapshot.
   *
   * @param frame - Event-lane vitals frame.
   */
  private applyVitals(frame: VitalsFrame): void {
    this.state.tick = frame.tick;
    this.state.vitals = frame;
  }

  /**
   * Merge a title event into `ui` title/subtitle/actionBar fields.
   *
   * @param frame - Event-lane title frame.
   */
  private applyTitle(frame: TitleFrame): void {
    this.state.tick = frame.tick;
    const ui: UI = { ...(this.state.ui ?? {}) };
    if (frame.clear) {
      ui.title = "";
      ui.subtitle = "";
      ui.actionBar = "";
    } else {
      if (frame.title !== undefined) ui.title = frame.title;
      if (frame.subtitle !== undefined) ui.subtitle = frame.subtitle;
      if (frame.actionBar !== undefined) ui.actionBar = frame.actionBar;
    }
    if (frame.fadeInTicks !== undefined) ui.fadeInTicks = frame.fadeInTicks;
    if (frame.stayTicks !== undefined) ui.stayTicks = frame.stayTicks;
    if (frame.fadeOutTicks !== undefined) ui.fadeOutTicks = frame.fadeOutTicks;
    this.state.ui = ui;
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
    this.state.pendingParticles.length = 0;
    this.state.fullReset = true;

    this.state.bot = frame.bot;
    this.state.tick = frame.tick;
    this.state.world = frame.world;
    this.state.actor = frame.actor;
    this.state.ui = frame.ui ?? null;
    this.state.formHover = null;
    // Registries are join-static; keyframe replaces, deltas never clear.
    this.state.registries = frame.registries ?? null;
    this.state.time = frame.time ?? null;
    this.state.camera = frame.camera ?? null;

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
    if (frame.ui !== undefined) {
      // Any UI replacement invalidates the hover: the hovered button belongs
      // to the previous form snapshot.
      if (formKey(this.state.ui) !== formKey(frame.ui ?? null)) {
        this.state.formHover = null;
      }
      this.state.ui = frame.ui ?? null;
    }
    if (frame.time !== undefined) this.state.time = frame.time;
    if (frame.cameraCleared) this.state.camera = null;
    else if (frame.camera !== undefined) this.state.camera = frame.camera;

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
      // Light stays at omission defaults until the next columnsAdded refill.
      const skyLight = new Uint8Array(4096);
      skyLight.fill(15);
      sec = {
        y: sy,
        indices: new Uint16Array(4096),
        palette: [{ name: "minecraft:air", states: {}, rid: 0 }],
        skyLight,
        blockLight: new Uint8Array(4096),
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

/**
 * Identity key for the open form (title + buttons); "" when none.
 *
 * @param ui - UI snapshot or null.
 * @returns a comparable key for hover invalidation.
 */
function formKey(ui: UI | null): string {
  const f = ui?.form;
  if (!f) return "";
  return `${f.title}\0${(f.buttons ?? []).join("\0")}`;
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
