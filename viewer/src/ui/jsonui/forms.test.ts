import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectFormButtonTexts,
  countCollectionInstances,
  normalizeFormButtonText,
} from "./collections.js";
import { createFixtureUiClient } from "./fixtureClient.js";
import {
  FORM_FLAG_ROUTES,
  collectBattleMoveRects,
  formBindingState,
  intersectingBattleMovePairs,
  prepareFormTree,
  routeForm,
  type FormSnapshot,
} from "./forms.js";
import { evalExpr, parseExpr } from "./expr.js";
import type { LayoutNode } from "./layout.js";
import { loadUiFileSet, parseLooseJson, parseUiRawFile } from "./load.js";
import { layoutTree } from "./layout.js";
import { buildResolver } from "./resolve.js";
import type { ResolvedElement, UiFileSource } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../testdata/jsonui");

/** Welcome / showRequiredMessageForm shape (title + body + one icon button). */
function welcomeFormSnapshot(): FormSnapshot {
  return {
    type: "action",
    title: "Welcome to PokeBedrock",
    content:
      "It looks like you are new to the server.\nOpen this book for a quick tour of the basics before you head out.",
    buttons: ["Continue"],
    buttonImages: ["textures/ui/book_notebook_icon"],
  };
}

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

  it("maps pokemon flag to pokemon.main_panel (starter picker)", () => {
    const r = routeForm({
      type: "menu",
      title: "§p§o§k§e§1",
      content: "",
      buttons: ["Bulbasaur"],
    });
    assert.equal(r.screen, "pokemon.main_panel");
    assert.equal(r.flag, "§p§o§k§e");
    assert.equal(r.kind, "flag");
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
    // Collection may insert an extra sep so pack `%.36s` lands on `.moveId`.
    assert.equal(
      collections.form_buttons![0]!["#form_button_text"],
      normalizeFormButtonText(form.buttons[0]!),
    );
    assert.ok(
      String(collections.form_buttons![0]!["#form_button_text"]).startsWith(
        "b:1_",
      ),
    );
  });
});

describe("starter picker fixture end-to-end", () => {
  it("expands picker_panel_grid via grid_item_template", () => {
    const pokemonDoc = parseLooseJson(
      readFileSync(join(fixtures, "pokebedrock/pokemon/pokemon.json"), "utf8"),
      "pokemon.json",
    );
    const resolver = buildResolver([
      src("pokebedrock", "ui/pokemon/pokemon.json", pokemonDoc),
    ]);
    const form: FormSnapshot = {
      type: "menu",
      title: "§p§o§k§e§1",
      content: "",
      buttons: [
        "§lBulbasaur§r\n§7No. 001",
        "§lCharmander§r\n§7No. 004",
        "§lSquirtle§r\n§7No. 007",
        "",
        "",
        "",
        "",
        "",
        "",
      ],
      buttonImages: [
        "textures/sprites/bulbasaur",
        "textures/sprites/charmander",
        "textures/sprites/squirtle",
        "",
        "",
        "",
        "",
        "",
        "",
      ],
    };
    const prepared = prepareFormTree(resolver, form);
    assert.ok(prepared, "pokemon.main_panel should resolve");
    assert.equal(prepared!.route.screen, "pokemon.main_panel");

    let pickerKids = -1;
    let pickerVisible = false;
    let stackVisible: boolean | undefined;
    walk(prepared!.tree, (el) => {
      if (el.name === "picker_panel_grid") {
        pickerKids = el.controls.length;
        pickerVisible = el.props.visible !== false;
        assert.deepEqual(el.props.grid_dimensions, [6, 2]);
      }
      if (el.name === "pokemon_panel_grid" || el.name === "button_stack") {
        if (el.props.collection_name === "form_buttons" && el.props.factory) {
          stackVisible = el.props.visible !== false;
        }
      }
    });
    assert.equal(pickerKids, form.buttons.length);
    assert.equal(pickerVisible, true, "§1 title shows picker grid");
    assert.equal(stackVisible, false, "§s stack stays hidden on picker title");

    const texts = collectFormButtonTexts(prepared!.tree);
    assert.ok(
      String(texts.get(0)).includes("Bulbasaur"),
      `button 0: ${texts.get(0)}`,
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

  it("lays out four move cards in a non-overlapping 2×2", () => {
    const attackDoc = parseLooseJson(
      readFileSync(join(fixtures, "pokebedrock/pokemon/attack.json"), "utf8"),
      "attack.json",
    );
    const resolver = buildResolver([
      src("pokebedrock", "ui/pokemon/attack.json", attackDoc),
    ]);
    const form = battleFormSnapshot();
    const prepared = prepareFormTree(resolver, form);
    assert.ok(prepared);
    const layout = layoutTree(
      prepared!.tree,
      { width: 640, height: 360 },
      {
        measureText: (text, fontScale) => ({
          w: Math.max(1, text.length * 6 * fontScale),
          h: 9 * fontScale,
        }),
      },
    );
    const moves = collectBattleMoveRects(layout);
    assert.equal(moves.length, 4, `moves=${JSON.stringify(moves)}`);
    assert.deepEqual(
      moves.map((m) => m.id),
      ["b:1_", "b:2_", "b:3_", "b:4_"],
    );
    assert.deepEqual(
      intersectingBattleMovePairs(moves),
      [],
      `overlap ${JSON.stringify(intersectingBattleMovePairs(moves))}`,
    );
    const xs = [...new Set(moves.map((m) => Math.round(m.x)))].sort(
      (a, b) => a - b,
    );
    const ys = [...new Set(moves.map((m) => Math.round(m.y)))].sort(
      (a, b) => a - b,
    );
    assert.equal(xs.length, 2, `columns=${xs}`);
    assert.equal(ys.length, 2, `rows=${ys}`);
    assert.ok(xs[1]! - xs[0]! > 80, `col gap ${xs[1]! - xs[0]!}`);
    assert.ok(ys[1]! - ys[0]! > 20, `row gap ${ys[1]! - ys[0]!}`);
  });
});

describe("BATTLE_PLATE_HP_BAG_ICONS", () => {
  function arenaBattleSnapshot(): FormSnapshot {
    const move = (slot: number, type: string, id: string, pp: string): string =>
      `b:${slot}_${pad30(type)} ${pad30(`.${id}`)} ${pad30(pp)}${id}`;
    return {
      type: "action",
      title: "§b§a§t§l§e§s§m§0§1",
      content: "Turn 1\n\nNo Turn Timer\n\nWeatherClear\n\nNo Terrain",
      buttons: [
        move(1, "normal", "growl", "40/40"),
        move(2, "grass", "vinewhip", "25/25"),
        move(3, "normal", "tackle", "35/35"),
        "battleButton:bagBag",
        "battleButton:pokemonParty",
        "battleButton:runFlee",
        "battleButton:move_selectionBadge",
        "§0§0§1§r§l§fBulbasaur§r\n Lv.5".padEnd(50, "_") + "G0.0⠀100%%",
        "§0§a§1§r§l§fMunchlax§r\n Lv.5".padEnd(50, "_") + "G0.0⠀100%%",
      ],
      buttonImages: [
        "t__20",
        "t__20",
        "t__20",
        "t",
        "t",
        "t",
        "t:_default",
        "textures/sprites/default/bulbasaur",
        "textures/sprites/default/munchlax",
      ],
    };
  }

  function layoutBattle() {
    const attackDoc = parseLooseJson(
      readFileSync(join(fixtures, "pokebedrock/pokemon/attack.json"), "utf8"),
      "attack.json",
    );
    const resolver = buildResolver([
      src("pokebedrock", "ui/pokemon/attack.json", attackDoc),
    ]);
    const prepared = prepareFormTree(resolver, arenaBattleSnapshot());
    assert.ok(prepared);
    const layout = layoutTree(
      prepared!.tree,
      { width: 640, height: 360 },
      {
        measureText: (text, fontScale) => ({
          w: Math.max(1, text.length * 6 * fontScale),
          h: 9 * fontScale,
        }),
      },
    );
    return { prepared: prepared!, layout };
  }

  function walkLayout(n: LayoutNode, visit: (n: LayoutNode) => void): void {
    visit(n);
    for (const c of n.children) walkLayout(c, visit);
  }

  it("keeps ally/foe plate AABB + portraits inside the viewport", () => {
    const { layout } = layoutBattle();
    const inset = 4;
    const vw = 640;
    const plates: Array<{ name: string; minX: number; maxX: number }> = [];
    walkLayout(layout, (n) => {
      if (
        n.element.name !== "opponent_actor_details_button" &&
        n.element.name !== "ally_actor_details_button"
      ) {
        return;
      }
      if (!n.visible || n.box.h < 20) return;
      let minX = Infinity;
      let maxX = -Infinity;
      walkLayout(n, (c) => {
        if (!c.visible || c.box.w <= 0 || c.box.h <= 0) return;
        minX = Math.min(minX, c.box.x);
        maxX = Math.max(maxX, c.box.x + c.box.w);
      });
      plates.push({ name: n.element.name, minX, maxX });
    });
    assert.ok(plates.length >= 2, `plates=${JSON.stringify(plates)}`);
    for (const p of plates) {
      assert.ok(p.minX >= inset - 0.5, `${p.name} minX=${p.minX}`);
      assert.ok(p.maxX <= vw - inset + 0.5, `${p.name} maxX=${p.maxX}`);
    }
  });

  it("sizes HP bars per plate (not hairline / not full viewport)", () => {
    const { layout } = layoutBattle();
    const hps: Array<{ w: number; h: number }> = [];
    walkLayout(layout, (n) => {
      if (n.element.name !== "variable_progress_bar") return;
      if (!n.visible || n.box.w <= 0) return;
      hps.push({ w: n.box.w, h: n.box.h });
    });
    assert.ok(hps.length >= 2, `hps=${JSON.stringify(hps)}`);
    for (const hp of hps) {
      assert.ok(hp.h >= 4, `hp hairline h=${hp.h}`);
      assert.ok(hp.w <= 120, `hp too wide w=${hp.w}`);
      assert.ok(hp.w >= 40, `hp too narrow w=${hp.w}`);
    }
  });

  it("caps bag_button host width so the blue tab is not a full-bar blob", () => {
    const { layout } = layoutBattle();
    const bags: number[] = [];
    walkLayout(layout, (n) => {
      if (n.element.name !== "bag_button" || !n.visible || n.box.w <= 0) return;
      bags.push(n.box.w);
    });
    assert.ok(bags.length >= 1, "bag_button");
    assert.ok(
      bags.every((w) => w <= 160),
      `bag widths=${bags}`,
    );
  });

  it("resolves normal + grass type icon paths; pack mirrors icon_offset by column", () => {
    const TYPE_EXPR =
      "(('textures/ui/gui/attacks/' + (%.8s * (#form_button_text - (%.4s * #form_button_text)))) - '_')";
    const expr = parseExpr(TYPE_EXPR);
    const { prepared } = layoutBattle();
    const bySlot = new Map<string, { tex: string; off: unknown }>();
    walk(prepared.tree, (el) => {
      if (el.name !== "icon" || el.props.visible === false) return;
      const text =
        typeof el.props.form_button_text === "string"
          ? el.props.form_button_text
          : "";
      const m = /^(b:[1-4]_)/.exec(text);
      if (!m) return;
      if (typeof el.props.texture !== "string") return;
      if (!bySlot.has(m[1]!)) {
        bySlot.set(m[1]!, { tex: el.props.texture, off: el.props.offset });
      }
    });
    assert.equal(bySlot.get("b:1_")?.tex, "textures/ui/gui/attacks/normal");
    assert.equal(bySlot.get("b:2_")?.tex, "textures/ui/gui/attacks/grass");
    assert.equal(bySlot.get("b:3_")?.tex, "textures/ui/gui/attacks/normal");
    // Pack attack.json mirrors $icon_offset: slots 1–2 use -15%, slots 3–4
    // use +15%. Factory clones carry every offset; gray "placeholder" on
    // Growl/Tackle is the real normal.png (not a 404).

    for (const [type, path] of [
      ["normal", "textures/ui/gui/attacks/normal"],
      ["grass", "textures/ui/gui/attacks/grass"],
    ] as const) {
      const label = `b:1_${type.padEnd(30, "_")} ${".x".padEnd(30, "_")} ${"1/1".padEnd(30, "_")}x`;
      const got = evalExpr(expr, {
        binding: (n) =>
          n === "form_button_text" ? normalizeFormButtonText(label) : undefined,
        variable: () => undefined,
      });
      assert.equal(got, path);
    }
  });
});

describe("welcome ActionForm dialogue chrome", () => {
  it("pins close X top-right, keeps body below title, binds Continue", async () => {
    const { files, globals } = await loadUiFileSet(
      createFixtureUiClient(fixtures),
    );
    const resolver = buildResolver(files, globals);
    const prepared = prepareFormTree(resolver, welcomeFormSnapshot());
    assert.ok(prepared);
    assert.equal(prepared!.route.kind, "long_form");

    let closeHolder: ResolvedElement | undefined;
    walk(prepared!.tree, (el) => {
      if (el.name === "close_button_holder") closeHolder = el;
    });
    assert.ok(closeHolder, "close_button_holder");
    assert.equal(closeHolder!.props.anchor_from, "top_right");
    assert.equal(closeHolder!.props.anchor_to, "top_right");
    assert.deepEqual(closeHolder!.props.size, ["100%", "100%"]);

    const layout = layoutTree(
      prepared!.tree,
      { width: 640, height: 360 },
      {
        measureText: (text, fontScale) => ({
          w: Math.max(1, text.length * 6 * fontScale),
          h: 9 * fontScale,
        }),
      },
    );

    let longForm: ReturnType<typeof layoutTree> | undefined;
    let closeBtn: ReturnType<typeof layoutTree> | undefined;
    let title: ReturnType<typeof layoutTree> | undefined;
    let body: ReturnType<typeof layoutTree> | undefined;
    let continueLabel: ReturnType<typeof layoutTree> | undefined;
    (function find(n: ReturnType<typeof layoutTree>): void {
      if (n.element.name === "long_form") longForm = n;
      if (n.element.name === "close_button") closeBtn = n;
      if (n.element.name === "standard_title_label") title = n;
      if (n.element.name === "main_label") body = n;
      if (
        typeof n.element.props.text === "string" &&
        n.element.props.text === "Continue"
      ) {
        continueLabel = n;
      }
      for (const c of n.children) find(c);
    })(layout);

    assert.ok(longForm && closeBtn && title && body && continueLabel);
    const formRight = longForm!.box.x + longForm!.box.w;
    const formTop = longForm!.box.y;
    assert.ok(
      closeBtn!.box.x + closeBtn!.box.w >= formRight - 30,
      `close x=${closeBtn!.box.x} formRight=${formRight}`,
    );
    assert.ok(
      closeBtn!.box.y <= formTop + 30,
      `close y=${closeBtn!.box.y} formTop=${formTop}`,
    );
    assert.ok(
      body!.box.y >= title!.box.y + title!.box.h,
      `body y=${body!.box.y} title bottom=${title!.box.y + title!.box.h}`,
    );
    assert.ok(
      continueLabel!.box.w > 0 && continueLabel!.box.h > 0,
      "Continue label laid out",
    );
  });
});
