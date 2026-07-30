import * as THREE from "three";
import type { CameraController, CameraMode } from "./camera";
import type { Overlay } from "./overlay";
import { columnKey, sectionIndex } from "./protocol";
import type { ViewerScene } from "./scene";
import type { Store } from "./store";
import type { HudHandle } from "./ui";

/** Exact shape exposed on `window.__viewer` for Playwright / the capture harness. */
export interface ViewerHandle {
  readonly blockInstanceCount: number;
  readonly sectionMeshCount: number;
  readonly columnCount: number;
  readonly entityCount: number;
  readonly highlightCount: number;
  readonly tick: number;
  readonly dimension: number;
  readonly schemaOk: boolean;
  readonly resyncCount: number;
  /** Frames that reached the store (0 until the first SSE payload is applied). */
  readonly framesReceived: number;
  /** Schema mismatch or latest stream/parse error; null when healthy. */
  readonly lastError: string | null;
  /** Active camera mode (`firstPerson` / `follow` / `orbit`). */
  readonly cameraMode: CameraMode;
  /** Burnt-in caption band text (suite · test · elapsed · status / message). */
  readonly captionText: string;
  /** Player HUD chat lines currently in the DOM. */
  readonly hudChatCount: number;
  /** Active block-break particle bursts. */
  readonly hudBurstCount: number;
  /** True once the remesh queue is empty after the latest frames. */
  settled: boolean;
  /**
   * True once texture-atlas loading has finished — either ready (textured
   * mesher installed) or failed (placeholder fallback). False only while the
   * pack fetch / atlas build is still in flight. Capture waits on this so a
   * still never lands on the loading screen or accidental placeholders.
   */
  readonly assetsSettled: boolean;
  /**
   * True once the pack-driven JSON UI runtime has loaded and mounted
   * (resolver ready). False while packs are still loading or if load failed.
   */
  readonly jsonUiReady: boolean;
  /** Force-drain the remesh queue (test helper). */
  flush: () => void;
  /**
   * Raycast a viewport pixel into the world meshes (diagnostic/test helper).
   *
   * @param sx - CSS pixel X from the canvas left edge.
   * @param sy - CSS pixel Y from the canvas top edge.
   * @returns hit point, the block coordinate just inside the surface, that
   * block's palette entry from the store, and the mesh's material name —
   * or null when the ray hits nothing.
   */
  probe: (
    sx: number,
    sy: number,
  ) => {
    point: number[];
    block: number[];
    palette: { name: string; states: Record<string, unknown> } | null;
    pass: string;
    /** Baked per-vertex atlasRect (u, v, w, h) of the hit triangle. */
    rect: number[] | null;
    /** Average RGBA of the material's atlas inside that rect. */
    rectAvg: number[] | null;
  } | null;
  /** Advance highlight fade clock (test helper; real time still drives opacity). */
  tickHighlights: (nowMs: number) => void;
  /** Diagnostic snapshot for smoke failures (not asserted). */
  diag: () => {
    sceneChildren: number;
    cam: number[];
    actorEye: number[] | null;
    pendingRemesh: number;
    gl: string | null;
  };
}

declare global {
  interface Window {
    __viewer?: ViewerHandle;
    /** Raw internals for interactive debugging; not part of the test contract. */
    __viewerInternals?: {
      store: Store;
      scene: ViewerScene;
      camera: CameraController;
      THREE: typeof THREE;
    };
  }
}

/**
 * Install the test handle from the live store + scene.
 *
 * Assigned at startup (before any frame) so a harness timeout can tell
 * "app never loaded" (`__viewer` missing) from "stream stuck"
 * (`schemaOk: false`, `framesReceived: 0`, `lastError` set).
 *
 * @param store - World model.
 * @param scene - Rendered scene.
 * @param getSettled - Returns whether the remesh queue is empty.
 * @param camera - Live camera (for `diag` / mode).
 * @param getStreamError - Latest EventSource/parse error from the stream layer.
 * @param overlay - Caption / forms panel (for `captionText`).
 * @param getAssetsSettled - True once atlas load succeeded or failed.
 * @param hud - Player HUD (chat / hotbar) for test counters.
 * @param getJsonUiReady - True once JSON UI packs loaded and HUD mounted.
 */
export function installViewerHandle(
  store: Store,
  scene: ViewerScene,
  getSettled: () => boolean,
  camera: CameraController,
  getStreamError: () => string = () => "",
  overlay?: Overlay,
  getAssetsSettled: () => boolean = () => true,
  hud?: HudHandle,
  getJsonUiReady: () => boolean = () => false,
): void {
  window.__viewerInternals = { store, scene, camera, THREE };
  window.__viewer = {
    get blockInstanceCount() {
      return scene.blockInstanceCount;
    },
    get sectionMeshCount() {
      return scene.sectionMeshCount;
    },
    get columnCount() {
      return store.getState().columns.size;
    },
    get entityCount() {
      return scene.entityCount;
    },
    get highlightCount() {
      return scene.highlightCount;
    },
    get tick() {
      return store.getState().tick;
    },
    get dimension() {
      return store.getState().world?.dimension ?? -1;
    },
    get schemaOk() {
      return store.getState().schemaOk;
    },
    get resyncCount() {
      return store.getState().resyncCount;
    },
    get framesReceived() {
      return store.getState().framesReceived;
    },
    get lastError() {
      const schema = store.getState().schemaError;
      if (schema) return schema;
      const stream = getStreamError();
      return stream.length > 0 ? stream : null;
    },
    get cameraMode() {
      return camera.mode;
    },
    get captionText() {
      return overlay?.captionText ?? "";
    },
    get hudChatCount() {
      return hud?.chatCount ?? 0;
    },
    get hudBurstCount() {
      return hud?.burstCount ?? 0;
    },
    get settled() {
      return getSettled();
    },
    set settled(_v: boolean) {
      /* settled is derived; setter kept so tests can assign without throwing */
    },
    get assetsSettled() {
      return getAssetsSettled();
    },
    get jsonUiReady() {
      return getJsonUiReady();
    },
    flush: () => {
      scene.flush(store.getState());
      store.clearDirty();
    },
    probe: (sx: number, sy: number) => {
      const canvas = scene.renderer.domElement;
      const ndc = new THREE.Vector2(
        (sx / canvas.clientWidth) * 2 - 1,
        -(sy / canvas.clientHeight) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera.perspective);
      const hits = ray.intersectObjects(scene.scene.children, true);
      const hit = hits.find((h) => (h.object as THREE.Mesh).isMesh);
      if (!hit) return null;
      // Step just inside the surface along the ray to land in the block.
      const inside = hit.point.clone().addScaledVector(ray.ray.direction, 0.01);
      const bx = Math.floor(inside.x);
      const by = Math.floor(inside.y);
      const bz = Math.floor(inside.z);
      const col = store.getState().columns.get(columnKey(bx >> 4, bz >> 4));
      const sec = col?.sections.get(by >> 4);
      const palette = sec
        ? (sec.palette[
            sec.indices[sectionIndex(bx & 15, by & 15, bz & 15)] ?? 0
          ] ?? null)
        : null;
      const obj = hit.object as THREE.Mesh;
      const mat = obj.material;
      const single = Array.isArray(mat) ? mat[0] : mat;
      const pass = `${String(obj.userData.pass ?? "?")}/${single?.type ?? "?"}`;
      // Baked per-vertex atlas rect + a sample of the material's atlas there —
      // separates "wrong rect baked" from "atlas content wrong".
      let rect: number[] | null = null;
      let rectAvg: number[] | null = null;
      const rectAttr = obj.geometry?.getAttribute("atlasRect");
      if (rectAttr && hit.face) {
        const vi = hit.face.a;
        rect = [
          rectAttr.getX(vi),
          rectAttr.getY(vi),
          rectAttr.getZ(vi),
          rectAttr.getW(vi),
        ];
        const texImg = (single as THREE.RawShaderMaterial | undefined)?.uniforms
          ?.map?.value?.image as HTMLCanvasElement | ImageBitmap | undefined;
        if (texImg && rect[2]! > 0 && rect[3]! > 0) {
          const cvs = new OffscreenCanvas(texImg.width, texImg.height);
          const c2 = cvs.getContext("2d")!;
          c2.drawImage(texImg, 0, 0);
          // Atlas rect uses GL bottom-up V; canvas reads top-down.
          const px = Math.round(rect[0]! * texImg.width);
          const ph = Math.round(rect[3]! * texImg.height);
          const py = texImg.height - Math.round(rect[1]! * texImg.height) - ph;
          const pw = Math.max(1, Math.round(rect[2]! * texImg.width));
          const data = c2.getImageData(px, py, pw, Math.max(1, ph)).data;
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          const n = data.length / 4;
          for (let i = 0; i < data.length; i += 4) {
            r += data[i]!;
            g += data[i + 1]!;
            b += data[i + 2]!;
            a += data[i + 3]!;
          }
          rectAvg = [r / n, g / n, b / n, a / n].map((v) => Math.round(v));
        }
      }
      return {
        point: [hit.point.x, hit.point.y, hit.point.z],
        block: [bx, by, bz],
        palette: palette
          ? { name: palette.name, states: palette.states ?? {} }
          : null,
        pass,
        rect,
        rectAvg,
      };
    },
    tickHighlights: (nowMs: number) => {
      scene.tickHighlights(nowMs);
    },
    diag: () => {
      const cam = camera.perspective;
      const actor = store.getState().actor;
      const gl = scene.renderer.getContext() as WebGLRenderingContext | null;
      return {
        sceneChildren: scene.scene.children.length,
        cam: [
          cam.position.x,
          cam.position.y,
          cam.position.z,
          cam.rotation.x,
          cam.rotation.y,
        ],
        actorEye: actor ? [...actor.eyePos] : null,
        pendingRemesh: scene.pendingRemeshCount,
        gl: gl ? `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}` : null,
      };
    },
  };
}
