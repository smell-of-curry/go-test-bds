import * as THREE from "three";
import type { CameraController } from "./camera";
import type { Block } from "./protocol";
import { columnKey, sectionIndex } from "./protocol";
import type { DecodedSection, StoredColumn, WorldState } from "./store";

/** Soft budget for remeshing work per animation frame (ms). */
export const REMESH_BUDGET_MS = 4;

/** Soft cap on sections remeshed in a single frame, even if budget remains. */
export const REMESH_MAX_SECTIONS_PER_FRAME = 8;

/** How long a block-change outline stays visible (ms). */
export const HIGHLIGHT_FADE_MS = 1000;

/** Cap live block outlines so a bulk delta cannot swamp the frame. */
export const HIGHLIGHT_MAX = 48;

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
  label: HTMLDivElement;
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
  private readonly labelsRoot: HTMLElement;
  private readonly sections = new Map<string, SectionNode>();
  private readonly entities = new Map<number, EntityNode>();
  private readonly columnBounds = new Map<string, THREE.LineSegments>();
  private readonly highlights: HighlightNode[] = [];
  private readonly actorGroup: THREE.Group;
  private readonly pendingSections: string[] = [];
  private pendingSet = new Set<string>();
  private storeRef: WorldState | null = null;
  private static readonly highlightGeo = new THREE.EdgesGeometry(
    new THREE.BoxGeometry(1.02, 1.02, 1.02),
  );

  blockInstanceCount = 0;
  sectionMeshCount = 0;

  constructor(
    canvas: HTMLCanvasElement,
    labelsRoot: HTMLElement,
    mesher: Mesher = new PlaceholderMesher(),
  ) {
    this.mesher = mesher;
    this.labelsRoot = labelsRoot;
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
    this.scene.background = new THREE.Color(0x0b0e14);

    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(0.6, 1, 0.3);
    this.scene.add(ambient, sun);

    this.actorGroup = new THREE.Group();
    this.actorGroup.visible = false;
    const actorGeo = new THREE.BoxGeometry(0.6, 1.8, 0.6);
    const actorEdges = new THREE.EdgesGeometry(actorGeo);
    const actorLine = new THREE.LineSegments(
      actorEdges,
      new THREE.LineBasicMaterial({ color: 0x66ccff }),
    );
    actorLine.position.y = 0.9;
    this.actorGroup.add(actorLine);
    this.scene.add(this.actorGroup);
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

    this.actorGroup.visible = showActor && !!state.actor;

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
   * @param show - Whether the body wireframe is visible.
   * @param actorPos - Feet position, or null when no actor.
   */
  setActorVisible(
    show: boolean,
    actorPos: [number, number, number] | null,
  ): void {
    if (!actorPos) {
      this.actorGroup.visible = false;
      return;
    }
    this.actorGroup.position.set(actorPos[0], actorPos[1], actorPos[2]);
    this.actorGroup.visible = show;
  }

  /**
   * Move an existing entity node to an interpolated pose. Missing rids are ignored
   * (structure still comes from {@link sync}).
   *
   * @param rid - Entity runtime ID.
   * @param pos - World position.
   */
  setEntityPos(rid: number, pos: [number, number, number]): void {
    const node = this.entities.get(rid);
    if (!node) return;
    node.group.position.set(pos[0], pos[1], pos[2]);
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
    this.updateLabels(camera);
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

  private upsertEntity(
    rid: number,
    ent: {
      pos: [number, number, number];
      bbox: [number, number];
      name: string;
      type: string;
    },
  ): void {
    let node = this.entities.get(rid);
    if (!node) {
      const group = new THREE.Group();
      group.name = `entity:${rid}`;
      const [w, h] = ent.bbox;
      const geo = new THREE.BoxGeometry(w, h, w);
      const edges = new THREE.EdgesGeometry(geo);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0xa0e0ff }),
      );
      line.position.y = h / 2;
      group.add(line);
      this.scene.add(group);

      const label = document.createElement("div");
      label.className = "entity-label";
      this.labelsRoot.appendChild(label);

      node = { rid, group, label };
      this.entities.set(rid, node);
    }

    const [w, h] = ent.bbox;
    node.group.position.set(ent.pos[0], ent.pos[1], ent.pos[2]);
    // Resize: replace geometry if bbox changed — cheap at entity counts we see.
    const line = node.group.children[0] as THREE.LineSegments;
    line.geometry.dispose();
    line.geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, w));
    line.position.y = h / 2;
    node.label.textContent = ent.name || ent.type;
  }

  private removeEntity(rid: number): void {
    const node = this.entities.get(rid);
    if (!node) return;
    this.scene.remove(node.group);
    for (const child of node.group.children) {
      const line = child as THREE.LineSegments;
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    node.label.remove();
    this.entities.delete(rid);
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

  private updateLabels(camera: CameraController): void {
    const width = this.renderer.domElement.clientWidth;
    const height = this.renderer.domElement.clientHeight;
    const cam = camera.perspective;
    for (const node of this.entities.values()) {
      const pos = node.group.position.clone();
      pos.y += 1.2;
      pos.project(cam);
      if (pos.z < -1 || pos.z > 1) {
        node.label.style.display = "none";
        continue;
      }
      node.label.style.display = "block";
      node.label.style.left = `${(pos.x * 0.5 + 0.5) * width}px`;
      node.label.style.top = `${(-pos.y * 0.5 + 0.5) * height}px`;
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
    for (const key of [...this.sections.keys()]) {
      this.removeSection(key);
      this.enqueueSection(key);
    }
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
