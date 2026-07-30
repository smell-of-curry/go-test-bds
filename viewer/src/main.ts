import {
  bobbingFromSearch,
  CameraController,
  cameraModeFromSearch,
} from "./camera";
import { installViewerHandle } from "./debug";
import { EntityModelRegistry } from "./entity";
import { MotionLerp } from "./motion";
import { Overlay } from "./overlay";
import { ParticleRegistry, ParticleSystem } from "./particles";
import type { Actor } from "./protocol";
import { LOADING_CLEAR, ViewerScene } from "./scene";
import { SnapshotStream, streamUrlFromSearch } from "./stream";
import { Store } from "./store";
import { createTexturedMesher } from "./terrain";
import { initHud } from "./ui";
import { createJsonUiRuntime } from "./ui/jsonui/runtime";
import { initWaypointStrip } from "./ui/waypointStrip";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const overlayEl = document.getElementById("overlay") as HTMLElement;
const errorEl = document.getElementById("schema-error") as HTMLElement;
const labelsEl = document.getElementById("labels") as HTMLElement;
const captionEl = document.getElementById("caption") as HTMLElement;
const uiEl = document.getElementById("ui-panel") as HTMLElement;
const crosshairEl = document.getElementById("crosshair") as HTMLElement;
const loadingEl = document.getElementById("loading") as HTMLElement;

const store = new Store();
const scene = new ViewerScene(canvas, labelsEl);

/**
 * Asset load lifecycle:
 * - loading: hide world, dark clear, show "loading textures…" — never capture
 *   accidental coloured placeholders.
 * - ready: textured mesher installed, sky clear, world visible.
 * - failed: keep placeholder mesher, sky clear, world visible (honest fallback
 *   for fixture runs / servers with no pack stack).
 */
type AssetsPhase = "loading" | "ready" | "failed";
let assetsPhase: AssetsPhase = "loading";
let streamError = "";
let assetError = "";
let lastActorRef: Actor | null = null;
let lastMotionRevision = -1;

function assetsSettled(): boolean {
  return assetsPhase !== "loading";
}

function setLoadingVisible(visible: boolean, detail?: string): void {
  loadingEl.classList.toggle("visible", visible);
  if (detail) loadingEl.textContent = detail;
}

function showWorld(): void {
  setLoadingVisible(false);
  const radiusChunks = store.getState().hello?.radius ?? 8;
  let assetBaseUrl = location.origin;
  try {
    assetBaseUrl = new URL(streamUrlFromSearch(location.search)).origin;
  } catch {
    /* keep location.origin */
  }
  scene.setEnvironment({ enabled: true, radiusChunks, assetBaseUrl });
  scene.setWorldTime(store.getState().time);
  scene.setWorldVisible(true);
}

// Hide world until the atlas settles (or fails). Placeholder cubes stay meshed
// underneath so a fail-fast path can reveal them without a remesh.
scene.setClearColor(LOADING_CLEAR);
scene.setWorldVisible(false);
setLoadingVisible(true, "loading textures…");

/**
 * Custom-block definitions (network palette) ride the first keyframe's
 * registries. Wait briefly for it so the atlas builds ONCE with custom tiles,
 * instead of building vanilla-only and rebuilding on arrival. `world` is set
 * only by a keyframe, so it doubles as the "keyframe applied" signal.
 * If the timeout fires first (vanilla-only atlas), the late-registries watcher
 * below rebuilds the atlas once when they finally land — a rebuilt atlas has a
 * different tile layout, so every already-meshed section must be remeshed or
 * its baked UV rects point at the wrong tiles (flat wrong-colour sections).
 */
const REGISTRIES_WAIT_MS = 5000;
const firstKeyframe = new Promise<void>((resolve) => {
  const done = (): void => {
    unsubscribe();
    clearTimeout(timer);
    resolve();
  };
  const unsubscribe = store.subscribe((state) => {
    if (state.world !== null) done();
  });
  const timer = setTimeout(done, REGISTRIES_WAIT_MS);
});

void firstKeyframe
  .then(() => createTexturedMesher({ registries: store.getState().registries }))
  .then(async (bundle) => {
    scene.setMesher(bundle.asMesher);
    assetsPhase = "ready";
    showWorld();
    // Remesh may be pending after setMesher — store subscribe / frame loop drain it.
    paintOverlay();
    watchLateRegistries(bundle, store.getState().registries !== null);

    // Entity defs share the terrain AssetClient / pack stack. Failure keeps
    // wireframes — do not fail the whole asset phase.
    try {
      const entities = new EntityModelRegistry(bundle.client);
      await entities.load();
      scene.setEntityRegistry(entities);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      assetError = assetError
        ? `${assetError}; entities: ${msg}`
        : `entities: ${msg}`;
      paintOverlay();
    }
    particleRegistry = new ParticleRegistry(bundle.client);
  })
  .catch((err: unknown) => {
    assetError = err instanceof Error ? err.message : String(err);
    assetsPhase = "failed";
    showWorld();
    paintOverlay();
  });

/**
 * Rebuild the atlas once if registries arrive only after the mesher was built
 * (keyframe slower than {@link REGISTRIES_WAIT_MS}). Registries are
 * join-static, so one application is enough for the life of the page.
 *
 * @param bundle - Installed textured-mesher bundle.
 * @param alreadyApplied - True when the mesher was built with registries.
 */
function watchLateRegistries(
  bundle: Awaited<ReturnType<typeof createTexturedMesher>>,
  alreadyApplied: boolean,
): void {
  if (alreadyApplied) return;
  let applying = false;
  const unsubscribe = store.subscribe((state) => {
    if (applying || state.registries === null) return;
    applying = true;
    unsubscribe();
    void bundle
      .applyRegistries(state.registries)
      .then(() => {
        // New atlas, new tile layout — baked UV rects in existing meshes are stale.
        scene.remeshAll();
      })
      .catch(() => {
        /* atlas rebuild failed — keep the vanilla-only atlas */
      });
  });
}

const camera = new CameraController(
  (canvas.clientWidth || window.innerWidth) /
    (canvas.clientHeight || window.innerHeight),
  cameraModeFromSearch(location.search),
  bobbingFromSearch(location.search),
);
const overlay = new Overlay(overlayEl, errorEl, captionEl, uiEl);
const particles = new ParticleSystem(scene.scene);
scene.particles = particles;
let particleRegistry: ParticleRegistry | null = null;
const hud = initHud({
  particles,
  getParticleRegistry: () => particleRegistry,
});
// Pack-driven JSON UI HUD (vanilla vitals + PokeBedrock PHUD). Textures /
// ui/*.json come from the hub's /packs + /pack/{id}/{path} + /asset routes.
let jsonUiAssetBase = "";
try {
  jsonUiAssetBase = new URL(streamUrlFromSearch(location.search)).origin;
} catch {
  /* fixture streams may be relative */
}
const jsonUi = createJsonUiRuntime({ assetBaseUrl: jsonUiAssetBase });
const waypointStrip = initWaypointStrip();
document.body.classList.add("jsonui-hud-active");
// The JSON UI runtime renders server forms through the pack's own screens;
// ?debugForms=1 restores the top-right debug panel instead.
document.body.classList.toggle(
  "jh-owns-forms",
  !new URLSearchParams(location.search).has("debugForms"),
);
const motion = new MotionLerp();

installViewerHandle(
  store,
  scene,
  // Live remesh queue — `flush()` drains it without sync/tickRemesh, so a
  // cached boolean would stay false forever after a forced drain.
  () => !store.getState().schemaOk || scene.pendingRemeshCount === 0,
  camera,
  () => streamError,
  overlay,
  assetsSettled,
  hud,
  () => jsonUi.getResolver() !== null,
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
  const assetLine =
    assetsPhase === "loading"
      ? "assets: loading textures…"
      : assetError
        ? `assets: ${assetError}`
        : "";
  overlay.render(store.getState(), camera.mode, {
    blockInstanceCount: scene.blockInstanceCount,
    sectionMeshCount: scene.sectionMeshCount,
    streamError: streamError || assetLine,
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
  scene.setWorldTime(state.time);
  camera.setServerOverride(state.camera, performance.now());

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

  hud.onFrame(state);
  jsonUi.onFrame(state);
  waypointStrip.onFrame(state);
  if (state.pendingParticles.length) {
    for (const pf of state.pendingParticles) {
      void spawnStreamParticle(pf.name, pf.pos);
    }
  }
  store.clearDirty();
  paintOverlay();
});

/**
 * Resolve a stream particle effect and spawn it (no-op when packs unavailable).
 *
 * @param name - Effect identifier.
 * @param pos - World position.
 */
async function spawnStreamParticle(
  name: string,
  pos: [number, number, number],
): Promise<void> {
  const reg = particleRegistry;
  if (!reg) return;
  const effect = await reg.get(name);
  if (!effect) return;
  await reg.bindTexture(particles, effect);
  particles.spawn(effect, pos);
}

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
  const dtSec = Math.min(0.25, (now - lastPaintAt) / 1000);
  lastPaintAt = now;

  const state = store.getState();
  if (state.schemaOk) {
    if (scene.pendingRemeshCount > 0) {
      scene.tickRemesh(state);
    }
    const nowMs = performance.now();
    scene.tickHighlights(nowMs);
    hud.tick(nowMs);

    const actor = motion.sampleActor() ?? state.actor;
    const entities = motion.sampleEntities();
    // MotionLerp (~inter-arrival / ~3 ticks) + Stage 9 bone animation.
    scene.tickEntities(dtSec > 0 ? dtSec : PAINT_INTERVAL_MS / 1000, entities);

    camera.setOccludeMeshes(scene.terrainMeshes());
    camera.update(actor, dtSec > 0 ? dtSec : PAINT_INTERVAL_MS / 1000, now);
    scene.setActorVisible(
      showActorBody(),
      actor ? actor.pos : null,
      actor?.rot,
    );
    scene.render(camera);
  }
  paintOverlay();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
