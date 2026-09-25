import assert from "node:assert/strict";
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
  type FormFlagRoute,
  collectBattleMoveRects,
  formBindingState,
  intersectingBattleMovePairs,
  prepareFormTree,
  routeForm,
  type FormSnapshot,
} from "./forms.js";
import { loadUiFileSet, parseUiRawFile } from "./load.js";
import { layoutTree } from "./layout.js";
import { buildResolver } from "./resolve.js";
import type { ResolvedElement, UiFileSource } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../testdata/jsonui");

/** Welcome / showRequiredMessageForm shape (title + body + one icon button). */
function welcomeFormSnapshot(): FormSnapshot {
  return {
    type: "action",
    title: "Welcome traveler",
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

const SAMPLE_ROUTES: FormFlagRoute[] = [
  { flag: "§b§a§t§l§e", screen: "battle.main" },
  { flag: "§p§o§k§e", screen: "pokemon.main_panel" },
];

function walk(el: ResolvedElement, visit: (el: ResolvedElement) => void): void {
  visit(el);
  for (const c of el.controls) walk(c.element, visit);
}

describe("routeForm", () => {
  it("maps battle flag to battle.main", () => {
    const r = routeForm(
      {
        type: "action",
        title: "§b§a§t§l§e§s§m",
        content: "",
        buttons: [],
      },
      SAMPLE_ROUTES,
    );
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
    const r = routeForm(
      {
        type: "menu",
        title: "§p§o§k§e§1",
        content: "",
        buttons: ["Bulbasaur"],
      },
      SAMPLE_ROUTES,
    );
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

  it("matches the first supplied flag route", () => {
    for (const { flag, screen } of SAMPLE_ROUTES) {
      const r = routeForm(
        {
          type: "action",
          title: `${flag}extra`,
          content: "",
          buttons: [],
        },
        SAMPLE_ROUTES,
      );
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

describe("synthetic pack screens", () => {
  const menuDoc = {
    namespace: "menu",
    cell: {
      type: "panel",
      size: ["15%", 30],
      bindings: [
        {
          binding_type: "collection",
          binding_collection_name: "form_buttons",
          binding_name: "#form_button_text",
          binding_name_override: "#form_button_text",
        },
      ],
    },
    main_panel: {
      type: "panel",
      size: ["100%", "100%"],
      controls: [
        {
          picker_panel_grid: {
            type: "grid",
            collection_name: "form_buttons",
            grid_item_template: "menu.cell",
            grid_dimensions: [6, 2],
            visible: true,
          },
        },
        {
          button_stack: {
            type: "stack_panel",
            collection_name: "form_buttons",
            factory: { control_name: "menu.cell" },
            visible: false,
          },
        },
      ],
    },
  };

  const battleDoc = {
    namespace: "battle",
    move_button: {
      type: "panel",
      size: [120, 28],
      anchor_from: "top_left",
      anchor_to: "top_left",
      bindings: [
        {
          binding_type: "collection",
          binding_collection_name: "form_buttons",
          binding_name: "#form_button_text",
          binding_name_override: "#form_button_text",
        },
      ],
      controls: [
        {
          button: {
            type: "panel",
            size: [100, 24],
            anchor_from: "top_left",
            anchor_to: "top_left",
          },
        },
      ],
    },
    main: {
      type: "panel",
      size: ["100%", "100%"],
      anchor_from: "top_left",
      anchor_to: "top_left",
      controls: [
        {
          info_label: {
            type: "label",
            bindings: [
              {
                binding_type: "global",
                binding_name: "#form_text",
                binding_name_override: "#text",
              },
            ],
          },
        },
        {
          moves: {
            type: "grid",
            size: [280, 80],
            anchor_from: "top_left",
            anchor_to: "top_left",
            offset: [20, 40],
            collection_name: "form_buttons",
            grid_item_template: "battle.move_button",
            grid_dimensions: [2, 2],
          },
        },
      ],
    },
  };

  it("expands a grid_item_template picker and hides the unused stack", () => {
    const resolver = buildResolver([src("addon", "ui/menu.json", menuDoc)]);
    const form: FormSnapshot = {
      type: "menu",
      title: "§p§o§k§e§1",
      content: "",
      buttons: ["One", "Two", "Three"],
      buttonImages: ["textures/ui/a", "textures/ui/b", "textures/ui/c"],
    };
    const prepared = prepareFormTree(resolver, form, {}, [
      { flag: "§p§o§k§e", screen: "menu.main_panel" },
    ]);
    assert.ok(prepared);
    assert.equal(prepared!.route.screen, "menu.main_panel");
    let pickerKids = -1;
    let pickerVisible = false;
    let stackVisible: boolean | undefined;
    walk(prepared!.tree, (el) => {
      if (el.name === "picker_panel_grid") {
        pickerKids = el.controls.length;
        pickerVisible = el.props.visible !== false;
      }
      if (el.name === "button_stack") stackVisible = el.props.visible !== false;
    });
    assert.equal(pickerKids, form.buttons.length);
    assert.equal(pickerVisible, true);
    assert.equal(stackVisible, false);
    const texts = collectFormButtonTexts(prepared!.tree);
    assert.ok(String(texts.get(0)).includes("One"));
  });

  it("routes a flag and expands move cards into a 2×2", () => {
    const resolver = buildResolver([src("addon", "ui/battle.json", battleDoc)]);
    const form: FormSnapshot = {
      type: "action",
      title: "§b§a§t§l§e",
      content: "Turn 1",
      buttons: ["b:1_a", "b:2_b", "b:3_c", "b:4_d"],
    };
    const prepared = prepareFormTree(resolver, form, {}, [
      { flag: "§b§a§t§l§e", screen: "battle.main" },
    ]);
    assert.ok(prepared, "battle.main should resolve");
    assert.equal(prepared!.route.screen, "battle.main");
    const instances = countCollectionInstances(prepared!.tree, "form_buttons");
    assert.ok(instances >= 4, `instances=${instances}`);
    const texts = collectFormButtonTexts(prepared!.tree);
    assert.equal(texts.size, 4);
    assert.ok(String(texts.get(0)).startsWith("b:1_"));
    let formText = "";
    walk(prepared!.tree, (el) => {
      if (el.name === "info_label" && typeof el.props.text === "string") {
        formText = el.props.text;
      }
    });
    assert.equal(formText, form.content);
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
    assert.equal(moves.length, 4, JSON.stringify(moves));
    assert.deepEqual(intersectingBattleMovePairs(moves), []);
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
