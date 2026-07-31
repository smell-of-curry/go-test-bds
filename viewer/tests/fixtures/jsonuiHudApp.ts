/**
 * Minimal mount page for JSON UI HUD Playwright checks.
 * Expects `?packs=` origin serving /packs + /pack/{id}/{path}.
 */
import { createJsonUiRuntime } from "../../src/ui/jsonui/runtime";
import type { VitalsFrame } from "../../src/protocol";
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

/**
 * @param phudExtra - Extra PHUD tokens merged over the default sidebar.
 * @param vitals - Optional vitals frame (survival HUD).
 * @returns fresh WorldState for one frame.
 */
function makeState(
  phudExtra: Record<string, string> = {},
  vitals: VitalsFrame | null = null,
  title: string | null = null,
  seedSidebar = true,
): WorldState {
  const phud = new Map<string, string>();
  if (seedSidebar) phud.set("sidebar", sidebarPayload());
  for (const [k, v] of Object.entries(phudExtra)) phud.set(k, v);
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
    ui: title ? { title } : null,
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
    phud,
    formHover: null,
    vitals,
    waypoint: null,
  };
}

void runtime.ready.then(() => {
  runtime.onFrame(makeState({}, null, null, true));
  document.body.dataset.ready = "1";
  document.body.dataset.frameMs = String(runtime.lastFrameMs);
  let lastVitals: VitalsFrame | null = null;
  let lastPhud: Record<string, string> = {};
  let lastTitle: string | null = null;
  let lastSeedSidebar = true;
  const api = {
    runtime,
    /**
     * Re-render with an updated PHUD map (sidebar kept unless overridden).
     *
     * @param phudExtra - Token → value; use `""` to clear a token.
     */

    /**
     * Re-render with a plain HUD title (tip chrome).
     *
     * @param title - Title text; null clears ui.title.
     */
    setTitle(title: string | null): void {
      lastTitle = title;
      runtime.onFrame(makeState(lastPhud, lastVitals, lastTitle, lastSeedSidebar));
      document.body.dataset.frameMs = String(runtime.lastFrameMs);
    },
    setPhud(phudExtra: Record<string, string>): void {
      lastPhud = phudExtra;
      runtime.onFrame(makeState(lastPhud, lastVitals, lastTitle, lastSeedSidebar));
      document.body.dataset.frameMs = String(runtime.lastFrameMs);
    },
    /**
     * Re-render survival HUD from a vitals frame (keeps last PHUD extras).
     *
     * @param vitals - Vitals SSE payload.
     */
    setVitals(vitals: VitalsFrame): void {
      lastVitals = vitals;
      runtime.onFrame(makeState(lastPhud, lastVitals, lastTitle, lastSeedSidebar));
      document.body.dataset.frameMs = String(runtime.lastFrameMs);
    },
    /**
     * Set PHUD tokens and vitals in one frame.
     *
     * @param phudExtra - Token map.
     * @param vitals - Vitals frame.
     */
    setHud(
      phudExtra: Record<string, string>,
      vitals: VitalsFrame,
      title?: string | null,
      seedSidebar = true,
    ): void {
      lastPhud = phudExtra;
      lastVitals = vitals;
      if (title !== undefined) lastTitle = title;
      lastSeedSidebar = seedSidebar;
      runtime.onFrame(makeState(lastPhud, lastVitals, lastTitle, lastSeedSidebar));
      document.body.dataset.frameMs = String(runtime.lastFrameMs);
    },
  };
  (window as unknown as { __jsonUi: typeof api }).__jsonUi = api;
});
