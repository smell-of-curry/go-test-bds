import type { CameraController, CameraMode } from "./camera";
import type { Overlay } from "./overlay";
import type { ViewerScene } from "./scene";
import type { Store } from "./store";

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
  /** True once the remesh queue is empty after the latest frames. */
  settled: boolean;
  /** Force-drain the remesh queue (test helper). */
  flush: () => void;
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
 * @param overlay - Caption / HUD (for `captionText`).
 */
export function installViewerHandle(
  store: Store,
  scene: ViewerScene,
  getSettled: () => boolean,
  camera: CameraController,
  getStreamError: () => string = () => "",
  overlay?: Overlay,
): void {
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
    get settled() {
      return getSettled();
    },
    set settled(_v: boolean) {
      /* settled is derived; setter kept so tests can assign without throwing */
    },
    flush: () => {
      scene.flush(store.getState());
      store.clearDirty();
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
