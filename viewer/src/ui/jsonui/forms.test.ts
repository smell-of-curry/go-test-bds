import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectFormButtonTexts,
  countCollectionInstances,
} from "./collections.js";
import {
  FORM_FLAG_ROUTES,
  formBindingState,
  prepareFormTree,
  routeForm,
  type FormSnapshot,
} from "./forms.js";
import { parseLooseJson, parseUiRawFile } from "./load.js";
import { buildResolver } from "./resolve.js";
import type { ResolvedElement, UiFileSource } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../testdata/jsonui");

function src(packId: string, path: string, doc: unknown): UiFileSource {
  const raw = parseUiRawFile(doc);
  assert.ok(raw, `bad doc for ${path}`);
  return { packId, path, raw: raw! };
}

function pad30(s: string): string {
  return s.padEnd(30, "_");
}

/** Synthetic battle ActionForm matching RESEARCH / BattleUtils encoding. */
function battleFormSnapshot(): FormSnapshot {
  const move = (slot: number, type: string, id: string, pp: string): string =>
    `b:${slot}_${pad30(type)} ${pad30(`.${id}`)} ${pad30(pp)}${id}`;
  return {
    type: "action",
    title: "§b§a§t§l§e§s§m§0§1",
    content: "Turn 3\nSunlight",
    buttons: [
      move(1, "normal", "growl", "40/40"),
      move(2, "grass", "vinewhip", "25/25"),
      move(3, "poison", "poisonpowder", "20/20"),
      move(4, "normal", "tackle", "35/35"),
      "battleButton:bagBag",
      "battleButton:pokemonParty",
      "battleButton:runFlee",
      "battleButton:move_selectionBadge",
    ],
    buttonImages: [
      "t__20",
      "t__20",
      "t__16",
      "t__20",
      "t",
      "t",
      "t",
      "t:_default",
    ],
  };
}

function walk(el: ResolvedElement, visit: (el: ResolvedElement) => void): void {
  visit(el);
  for (const c of el.controls) walk(c.element, visit);
}

describe("routeForm", () => {
  it("maps battle flag to battle.main", () => {
    const r = routeForm({
      type: "action",
      title: "§b§a§t§l§e§s§m",
      content: "",
      buttons: [],
    });
    assert.equal(r.screen, "battle.main");
    assert.equal(r.namespace, "battle");
    assert.equal(r.name, "main");
    assert.equal(r.flag, "§b§a§t§l§e");
    assert.equal(r.kind, "flag");
  });

  it("plain title → vanilla long_form", () => {
    const r = routeForm({
      type: "action",
      title: "Choose a starter",
      content: "Pick one",
      buttons: ["Bulbasaur"],
    });
    assert.equal(r.screen, "server_form.long_form");
    assert.equal(r.kind, "long_form");
  });

  it("modal/custom type → custom_form", () => {
    const r = routeForm({
      type: "modal",
      title: "Settings",
      content: "",
      buttons: [],
    });
    assert.equal(r.screen, "server_form.custom_form");
    assert.equal(r.kind, "custom_form");
  });

  it("covers every documented flag route", () => {
    for (const { flag, screen } of FORM_FLAG_ROUTES) {
      const r = routeForm({
        type: "action",
        title: `${flag}extra`,
        content: "",
        buttons: [],
      });
      assert.equal(r.screen, screen, flag);
    }
  });
});

describe("formBindingState", () => {
  it("feeds title/body/length + form_buttons items", () => {
    const form = battleFormSnapshot();
    const { source, collections } = formBindingState(form);
    assert.equal(source.global("#title_text"), form.title);
    assert.equal(source.global("#form_text"), form.content);
    assert.equal(source.global("#form_button_length"), form.buttons.length);
    assert.equal(collections.form_buttons!.length, form.buttons.length);
    assert.equal(
      collections.form_buttons![0]!["#form_button_text"],
      form.buttons[0],
    );
  });
});

describe("battle fixture end-to-end", () => {
  it("expands form_buttons and shows move + bag/run visibility", () => {
    const attackDoc = parseLooseJson(
      readFileSync(join(fixtures, "pokebedrock/pokemon/attack.json"), "utf8"),
      "attack.json",
    );
    const resolver = buildResolver([
      src("pokebedrock", "ui/pokemon/attack.json", attackDoc),
    ]);

    const form = battleFormSnapshot();
    const prepared = prepareFormTree(resolver, form);
    assert.ok(prepared, "battle.main should resolve from attack.json");
    assert.equal(prepared!.route.screen, "battle.main");

    const tree = prepared!.tree;
    // Three button_stacks on main (left actions, move_selection, move grid)
    // each expand to N form buttons.
    const instances = countCollectionInstances(tree, "form_buttons");
    assert.ok(
      instances >= form.buttons.length,
      `expected >= ${form.buttons.length} factory instances, got ${instances}`,
    );

    const texts = collectFormButtonTexts(tree);
    assert.equal(texts.size, form.buttons.length);
    for (let i = 0; i < 4; i++) {
      assert.ok(
        String(texts.get(i)).startsWith(`b:${i + 1}_`),
        `move ${i + 1}: ${texts.get(i)}`,
      );
    }

    // Visible move slots: grid_button_check_id whose view binding left
    // visible !== false for the matching b:N_ item.
    const visibleMovePrefixes = new Set<string>();
    walk(tree, (el) => {
      const text =
        typeof el.props.form_button_text === "string"
          ? el.props.form_button_text
          : "";
      if (!/^b:[1-4]_/.test(text)) return;
      if (el.props.visible === false) return;
      if (el.name === "grid_button_check_id" || el.name === "move_button") {
        visibleMovePrefixes.add(text.slice(0, 4));
      }
    });
    assert.deepEqual([...visibleMovePrefixes].sort(), [
      "b:1_",
      "b:2_",
      "b:3_",
      "b:4_",
    ]);

    // Bag / run action buttons: at least one instance with matching text and
    // visible !== false after view bindings.
    let bagVisible = false;
    let runVisible = false;
    walk(tree, (el) => {
      const text =
        typeof el.props.form_button_text === "string"
          ? el.props.form_button_text
          : "";
      if (el.props.visible === false) return;
      if (text.includes("battleButton:bag")) bagVisible = true;
      if (text.includes("battleButton:run")) runVisible = true;
    });
    assert.equal(bagVisible, true, "bag button should be visible");
    assert.equal(runVisible, true, "run button should be visible");

    // Info panel materializes #form_text.
    let formText = "";
    walk(tree, (el) => {
      if (el.name === "info_label" && typeof el.props.text === "string") {
        formText = el.props.text;
      }
    });
    assert.equal(formText, form.content);
  });
});
