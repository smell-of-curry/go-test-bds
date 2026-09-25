import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { airBubblesVisible, bindingSourceFromState, heartIcons } from "./hud";
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
    titleTokens: new Map(),
    formHover: null,
    vitals: null,
    waypoint: null,
    ...over,
  };
}

describe("bindingSourceFromState", () => {
  it("maps plain title lane to #hud_title_text_string", () => {
    const state = emptyState({ ui: { title: "Level Up!" } });
    const src = bindingSourceFromState(state, "Level Up!");
    assert.equal(src.global("#hud_title_text_string"), "Level Up!");
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
    // xpProgress > 0 still wants the thin XP strip; level glyph stays hidden.
    assert.equal(src.global("#hotbar_with_xp_bar"), true);
    assert.equal(src.global("#hotbar_no_xp_bar"), false);
    assert.equal(src.global("#hotbar_with_locator_bar"), false);
  });

  it("hides XP strip when level and progress are both zero", () => {
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
          xpProgress: 0,
          selectedSlot: 0,
          hotbar: Array(9).fill(null),
        },
      }),
      "",
    );
    assert.equal(src.global("#hotbar_with_xp_bar"), false);
    assert.equal(src.global("#hotbar_no_xp_bar"), true);
    assert.equal(src.global("#is_not_riding_bubbles"), false);
    assert.equal(src.global("#is_armor_visible"), false);
  });

  it("hides bubbles when air is 0 / missing (land glitch)", () => {
    assert.equal(
      airBubblesVisible({
        v: 1,
        type: "vitals",
        bot: "Bot",
        tick: 1,
        health: 20,
        maxHealth: 20,
        food: 20,
        air: 0,
        maxAir: 300,
        armor: 0,
        xpLevel: 0,
        xpProgress: 0,
        selectedSlot: 0,
        hotbar: Array(9).fill(null),
      }),
      false,
    );
    assert.equal(
      airBubblesVisible({
        v: 1,
        type: "vitals",
        bot: "Bot",
        tick: 1,
        health: 20,
        maxHealth: 20,
        food: 20,
        xpLevel: 0,
        xpProgress: 0,
        selectedSlot: 0,
        hotbar: Array(9).fill(null),
      }),
      false,
    );
    assert.equal(
      airBubblesVisible({
        v: 1,
        type: "vitals",
        bot: "Bot",
        tick: 1,
        health: 20,
        maxHealth: 20,
        food: 20,
        air: 120,
        maxAir: 300,
        armor: 0,
        xpLevel: 0,
        xpProgress: 0,
        selectedSlot: 0,
        hotbar: Array(9).fill(null),
      }),
      true,
    );
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
