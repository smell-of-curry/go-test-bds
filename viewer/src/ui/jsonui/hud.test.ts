import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyTitleQuirk,
  bindingSourceFromState,
  heartIcons,
  hudTitleString,
  PhudTitleTracker,
  PHUD_TITLE_RE,
} from "./hud";
import type { ResolvedElement } from "./types";
import type { WorldState } from "../../store";

function emptyState(over: Partial<WorldState> = {}): WorldState {
  return {
    schemaOk: true,
    schemaError: null,
    hello: null,
    tick: 0,
    bot: "Bot",
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
    ...over,
  };
}

describe("bindingSourceFromState / hudTitleString", () => {
  it("maps plain title lane to #hud_title_text_string", () => {
    const state = emptyState({ ui: { title: "Level Up!" } });
    const src = bindingSourceFromState(state, hudTitleString(state, ""));
    assert.equal(src.global("#hud_title_text_string"), "Level Up!");
  });

  it("maps reconstructed phud token to #hud_title_text_string", () => {
    const state = emptyState();
    const title = "&_sidebar:payload";
    const src = bindingSourceFromState(state, title);
    assert.equal(src.global("#hud_title_text_string"), title);
  });

  it("prefers plain title over last phud title", () => {
    const state = emptyState({ ui: { title: "Hello" } });
    assert.equal(hudTitleString(state, "&_phone:ring"), "Hello");
  });
});

describe("PhudTitleTracker latch across tokens", () => {
  it("keeps sidebar payload when phone token arrives later", () => {
    const tracker = new PhudTitleTracker();
    const phud = new Map<string, string>();
    phud.set("sidebar", "SIDEBAR_X");
    assert.equal(tracker.update(phud), "&_sidebar:SIDEBAR_X");

    phud.set("phone", "ring");
    assert.equal(tracker.update(phud), "&_phone:ring");

    // Map still holds sidebar value — pack latch uses preserved_text, not title.
    assert.equal(phud.get("sidebar"), "SIDEBAR_X");
    assert.equal(phud.get("phone"), "ring");
  });

  it("emits &_token: when value cleared so pack latches hide", () => {
    const tracker = new PhudTitleTracker();
    const phud = new Map<string, string>();
    phud.set("playerPing", "§a63");
    assert.equal(tracker.update(phud), "&_playerPing:§a63");
    phud.set("playerPing", "");
    assert.equal(tracker.update(phud), "&_playerPing:");
  });
});

describe("title quirk", () => {
  it("matches PHUD control tokens", () => {
    assert.ok(PHUD_TITLE_RE.test("&_sidebar:x"));
    assert.ok(PHUD_TITLE_RE.test("&_phone:ring"));
    assert.equal(PHUD_TITLE_RE.test("Level Up!"), false);
  });

  it("force-hides title subtree for &_ tokens", () => {
    const title: ResolvedElement = {
      type: "label",
      name: "title",
      namespace: "hud",
      props: { visible: true, text: "&_sidebar:x" },
      controls: [],
      bindings: [],
    };
    const root: ResolvedElement = {
      type: "stack_panel",
      name: "hud_title_text",
      namespace: "hud",
      props: { visible: true },
      controls: [{ id: "title", element: title }],
      bindings: [],
    };
    applyTitleQuirk(root, "&_sidebar:x");
    assert.equal(root.props.visible, false);
    assert.equal(title.props.visible, false);
  });

  it("leaves plain titles visible", () => {
    const root: ResolvedElement = {
      type: "stack_panel",
      name: "hud_title_text",
      namespace: "hud",
      props: { visible: true },
      controls: [],
      bindings: [],
    };
    applyTitleQuirk(root, "Level Up!");
    assert.equal(root.props.visible, true);
  });
});

describe("heartIcons", () => {
  it("health 7/20 → 3 full + 1 half + 6 empty", () => {
    assert.deepEqual(heartIcons(7), { full: 3, half: 1, empty: 6 });
  });

  it("health 20 → all full", () => {
    assert.deepEqual(heartIcons(20), { full: 10, half: 0, empty: 0 });
  });

  it("health 0 → all empty", () => {
    assert.deepEqual(heartIcons(0), { full: 0, half: 0, empty: 10 });
  });
});

describe("vitalsGlobals visibility", () => {
  it("hides level number at xpLevel 0", () => {
    const src = bindingSourceFromState(
      emptyState({
        vitals: {
          v: 1,
          type: "vitals",
          bot: "Bot",
          tick: 1,
          health: 20,
          maxHealth: 20,
          food: 20,
          air: 300,
          maxAir: 300,
          armor: 0,
          xpLevel: 0,
          xpProgress: 0.25,
          selectedSlot: 0,
          hotbar: Array(9).fill(null),
        },
      }),
      "",
    );
    assert.equal(src.global("#level_number_visible"), false);
    assert.equal(src.global("#level_number"), "0");
    assert.equal(src.global("#hotbar_elipses_left_visible"), false);
    assert.equal(src.global("#hotbar_elipses_right_visible"), false);
    assert.equal(src.global("#hotbar_with_xp_bar"), true);
    assert.equal(src.global("#hotbar_no_xp_bar"), false);
    assert.equal(src.global("#hotbar_with_locator_bar"), false);
  });

  it("shows level number when xpLevel > 0", () => {
    const src = bindingSourceFromState(
      emptyState({
        vitals: {
          v: 1,
          type: "vitals",
          bot: "Bot",
          tick: 1,
          health: 20,
          maxHealth: 20,
          food: 20,
          air: 300,
          maxAir: 300,
          armor: 0,
          xpLevel: 12,
          xpProgress: 0.5,
          selectedSlot: 2,
          hotbar: Array(9).fill(null),
        },
      }),
      "",
    );
    assert.equal(src.global("#level_number_visible"), true);
    assert.equal(src.global("#level_number"), "12");
  });

  it("hides ellipses / tips even without vitals", () => {
    const src = bindingSourceFromState(emptyState(), "");
    assert.equal(src.global("#hotbar_elipses_left_visible"), false);
    assert.equal(src.global("#hotbar_elipses_right_visible"), false);
    assert.equal(src.global("#paper_doll_visible"), false);
    assert.equal(src.global("#hotbar_with_xp_bar"), false);
  });
});
