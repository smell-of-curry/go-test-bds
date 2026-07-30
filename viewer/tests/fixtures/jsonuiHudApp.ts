/**
 * Minimal mount page for JSON UI HUD Playwright checks.
 * Expects `?packs=` origin serving /packs + /pack/{id}/{path}.
 */
import { createJsonUiRuntime } from "../../src/ui/jsonui/runtime";
import type { WorldState } from "../../src/store";

const params = new URLSearchParams(location.search);
const packsOrigin = params.get("packs") ?? location.origin;
const host = document.getElementById("host")!;

const runtime = createJsonUiRuntime({
  assetBaseUrl: packsOrigin,
  host,
  guiScale: 2,
});

/**
 * Pad one sidebar field to 120 chars with `|`.
 *
 * @param s - Field value.
 * @returns padded field.
 */
function pad120(s: string): string {
  return s.padEnd(120, "|").slice(0, 120);
}

/**
 * Build a 6-slot sidebar payload (slot0 filled, rest empty).
 *
 * @returns packed sidebar body (no `&_sidebar:` prefix).
 */
function sidebarPayload(): string {
  const empty = ["null", "null", "null", "false", "empty", "null", "100"];
  const slot0 = [
    "HP: 20/20 Lv.5",
    "TestBot",
    "pikachu",
    "true",
    "pokeball",
    "default/pikachu",
    "40",
  ];
  const fields: string[] = [];
  for (let s = 0; s < 6; s++) {
    const row = s === 0 ? slot0 : empty;
    for (const f of row) fields.push(pad120(f));
  }
  return fields.join("|");
}

function emptyState(): WorldState {
  return {
    schemaOk: true,
    schemaError: null,
    hello: null,
    tick: 1,
    bot: "TestBot",
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
    framesReceived: 1,
    revision: 1,
    dirtySections: new Set(),
    dirtyColumns: new Set(),
    dirtyEntities: new Set(),
    removedEntities: new Set(),
    dirtyBlocks: [],
    pendingParticles: [],
    fullReset: false,
    time: null,
    camera: null,
    phud: new Map([["sidebar", sidebarPayload()]]),
    formHover: null,
    vitals: null,
    waypoint: null,
  };
}

void runtime.ready.then(() => {
  runtime.onFrame(emptyState());
  document.body.dataset.ready = "1";
  document.body.dataset.frameMs = String(runtime.lastFrameMs);
  (window as unknown as { __jsonUi: typeof runtime }).__jsonUi = runtime;
});
