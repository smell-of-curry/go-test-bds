import { CameraController, cameraModeFromSearch } from "./camera";
import { installViewerHandle } from "./debug";
import { MotionLerp } from "./motion";
import { Overlay } from "./overlay";
import type { Actor } from "./protocol";
import { ViewerScene } from "./scene";
import { SnapshotStream, streamUrlFromSearch } from "./stream";
import { Store } from "./store";
import { createTexturedMesher } from "./terrain";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const overlayEl = document.getElementById("overlay") as HTMLElement;
const errorEl = document.getElementById("schema-error") as HTMLElement;
const labelsEl = document.getElementById("labels") as HTMLElement;
const captionEl = document.getElementById("caption") as HTMLElement;
const uiEl = document.getElementById("ui-panel") as HTMLElement;
const crosshairEl = document.getElementById("crosshair") as HTMLElement;

const store = new Store();
const scene = new ViewerScene(canvas, labelsEl);
// Textures come from the pack stack the bot serves, so they arrive later than
// the scene does and may not arrive at all — an offline cache, a server that
// sent no packs, a baseline that was never fetched. Coloured placeholders are
// the honest fallback: a viewer that renders the world badly still shows where
// the bot was standing, and one that refuses to start shows nothing.
void createTexturedMesher()
  .then(({ asMesher }) => {
    scene.setMesher(asMesher);
  })
  .catch((err: unknown) => {
    assetError = err instanceof Error ? err.message : String(err);
  });
const camera = new CameraController(
  (canvas.clientWidth || window.innerWidth) /
    (canvas.clientHeight || window.innerHeight),
  cameraModeFromSearch(location.search),
);
const overlay = new Overlay(overlayEl, errorEl, captionEl, uiEl);
const motion = new MotionLerp();

let streamError = "";
let assetError = "";
let lastActorRef: Actor | null = null;
let lastMotionRevision = -1;

installViewerHandle(
  store,
  scene,
  // Live remesh queue — `flush()` drains it without sync/tickRemesh, so a
  // cached boolean would stay false forever after a forced drain.
  () => !store.getState().schemaOk || scene.pendingRemeshCount === 0,
  camera,
  () => streamError,
  overlay,
);

camera.bindOrbitControls(canvas);

window.addEventListener("keydown", (e) => {
  if (e.code === "KeyC") camera.toggleMode();
});

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w;
  canvas.height = h;
  scene.resize(w, h);
  camera.resize(w / h);
}
window.addEventListener("resize", resize);
resize();

function showActorBody(): boolean {
  return camera.mode === "orbit" || camera.mode === "follow";
}

function paintOverlay(): void {
  overlay.render(store.getState(), camera.mode, {
    blockInstanceCount: scene.blockInstanceCount,
    sectionMeshCount: scene.sectionMeshCount,
    streamError: streamError || (assetError ? `assets: ${assetError}` : ""),
  });
  crosshairEl.style.display = camera.mode === "firstPerson" ? "block" : "none";
}

store.subscribe((state) => {
  if (!state.schemaOk) {
    motion.clear();
    lastActorRef = null;
    lastMotionRevision = state.revision;
    paintOverlay();
    return;
  }

  scene.sync(state, showActorBody());

  // Pose samples only when the world pose actually changed — mark/capture
  // frames must not restart the lerp.
  const poseChanged =
    state.fullReset ||
    state.actor !== lastActorRef ||
    state.dirtyEntities.size > 0 ||
    state.removedEntities.size > 0;
  if (poseChanged && state.revision !== lastMotionRevision) {
    motion.push(state.actor, state.entities, state.fullReset);
    lastActorRef = state.actor;
    lastMotionRevision = state.revision;
  }

  store.clearDirty();
  paintOverlay();
});

const streamUrl = streamUrlFromSearch(location.search);
const stream = new SnapshotStream(streamUrl, {
  onFrame: (frame) => store.apply(frame),
  onError: (err) => {
    streamError = err.message;
  },
  onOpen: () => {
    streamError = "";
  },
});
stream.start();

/**
 * Minimum gap between renders, in milliseconds.
 *
 * The simulation ticks at 20 Hz, so painting faster than that shows nothing
 * new, and capture runs on software GL where each frame is expensive enough to
 * matter. Interpolation still runs per paint, so motion stays smooth.
 */
const PAINT_INTERVAL_MS = 50;
// Negative infinity, not 0: `performance.now()` is already tens of milliseconds
// at load, so a zero start would skip the very first paint and leave the camera
// at the origin for a frame — which a screenshot taken immediately would catch.
let lastPaintAt = Number.NEGATIVE_INFINITY;

function frame(): void {
  const now = performance.now();
  if (now - lastPaintAt < PAINT_INTERVAL_MS) {
    requestAnimationFrame(frame);
    return;
  }
  lastPaintAt = now;

  const state = store.getState();
  if (state.schemaOk) {
    if (scene.pendingRemeshCount > 0) {
      scene.tickRemesh(state);
    }
    scene.tickHighlights(performance.now());

    const actor = motion.sampleActor() ?? state.actor;
    const entities = motion.sampleEntities();
    for (const [rid, ent] of entities) {
      scene.setEntityPos(rid, ent.pos);
    }

    camera.update(actor);
    scene.setActorVisible(showActorBody(), actor ? actor.pos : null);
    scene.render(camera);
  }
  paintOverlay();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
