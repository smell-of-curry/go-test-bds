import { CameraController } from "./camera";
import { installViewerHandle } from "./debug";
import { Overlay } from "./overlay";
import { ViewerScene } from "./scene";
import { SnapshotStream, streamUrlFromSearch } from "./stream";
import { Store } from "./store";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const overlayEl = document.getElementById("overlay") as HTMLElement;
const errorEl = document.getElementById("schema-error") as HTMLElement;
const labelsEl = document.getElementById("labels") as HTMLElement;

const store = new Store();
const scene = new ViewerScene(canvas, labelsEl);
const camera = new CameraController(
  (canvas.clientWidth || window.innerWidth) /
    (canvas.clientHeight || window.innerHeight),
);
const overlay = new Overlay(overlayEl, errorEl);

let streamError = "";
let settled = true;

installViewerHandle(store, scene, () => settled, camera);

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

function paintOverlay(): void {
  overlay.render(store.getState(), camera.mode, {
    blockInstanceCount: scene.blockInstanceCount,
    sectionMeshCount: scene.sectionMeshCount,
    streamError,
  });
}

store.subscribe((state) => {
  if (!state.schemaOk) {
    settled = true;
    paintOverlay();
    return;
  }
  settled = scene.sync(state, camera.mode === "orbit");
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

function frame(): void {
  const state = store.getState();
  if (state.schemaOk) {
    if (scene.pendingRemeshCount > 0) {
      settled = scene.tickRemesh(state);
    }
    camera.update(state.actor);
    scene.setOrbitMode(
      camera.mode === "orbit",
      state.actor ? state.actor.pos : null,
    );
    scene.render(camera);
  }
  paintOverlay();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
