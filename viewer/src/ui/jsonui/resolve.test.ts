import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseLooseJson, parseUiRawFile } from "./load";
import { buildResolver, parseElementName } from "./resolve";
import type { UiFileSource } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../testdata/jsonui");

function src(packId: string, path: string, doc: unknown): UiFileSource {
  const raw = parseUiRawFile(doc);
  assert.ok(raw, `bad doc for ${path}`);
  return { packId, path, raw: raw! };
}

test("parseElementName: cross-namespace base", () => {
  assert.deepEqual(parseElementName("root_panel@common.base"), {
    name: "root_panel",
    base: { namespace: "common", name: "base" },
  });
});

test("parseElementName: same-namespace base", () => {
  assert.deepEqual(parseElementName("foo@bar"), {
    name: "foo",
    base: { name: "bar" },
  });
});

test("parseElementName: no base", () => {
  assert.deepEqual(parseElementName("foo"), { name: "foo" });
});

test("base-chain merge: derived-most wins", () => {
  const r = buildResolver([
    src("v", "ui/a.json", {
      namespace: "ns",
      base: { type: "panel", size: [1, 1], alpha: 0.5 },
      "child@base": { size: [2, 2], layer: 3 },
    }),
  ]);
  const el = r.resolve("ns", "child");
  assert.ok(el);
  assert.equal(el!.type, "panel");
  assert.deepEqual(el!.props.size, [2, 2]);
  assert.equal(el!.props.alpha, 0.5);
  assert.equal(el!.props.layer, 3);
});

test("cross-namespace inheritance", () => {
  const r = buildResolver([
    src("v", "ui/common.json", {
      namespace: "common",
      base: { type: "screen", layer: 1 },
    }),
    src("v", "ui/hud.json", {
      namespace: "hud",
      "hud_screen@common.base": { layer: 9 },
    }),
  ]);
  const el = r.resolve("hud", "hud_screen");
  assert.ok(el);
  assert.equal(el!.type, "screen");
  assert.equal(el!.props.layer, 9);
  assert.equal(el!.namespace, "hud");
});

test("$variable substitution + control-instance override", () => {
  const r = buildResolver([
    src("v", "ui/a.json", {
      namespace: "ns",
      label: {
        type: "label",
        "$color|default": [1, 0, 0],
        color: "$color",
        text: "$label_text",
      },
      parent: {
        type: "panel",
        $label_text: "hi",
        controls: [
          {
            "child@label": {
              $color: [0, 1, 0],
              $label_text: "over",
            },
          },
        ],
      },
    }),
  ]);
  const parent = r.resolve("ns", "parent");
  assert.ok(parent);
  assert.equal(parent!.controls.length, 1);
  const child = parent!.controls[0]!;
  assert.equal(child.id, "child");
  assert.deepEqual(child.element.props.color, [0, 1, 0]);
  assert.equal(child.element.props.text, "over");
});

test("controls ordering preserved", () => {
  const r = buildResolver([
    src("v", "ui/a.json", {
      namespace: "ns",
      root: {
        type: "panel",
        controls: [
          { a: { type: "label" } },
          { "b@a": {} },
          { c: { type: "image" } },
        ],
      },
      a: { type: "label", text: "x" },
    }),
  ]);
  const el = r.resolve("ns", "root");
  assert.deepEqual(
    el!.controls.map((c) => c.id),
    ["a", "b", "c"],
  );
  assert.equal(el!.controls[0]!.element.type, "label");
  assert.equal(el!.controls[2]!.element.type, "image");
});

test("modifications: insert_back + replace + remove", () => {
  const r = buildResolver([
    src("vanilla", "ui/hud.json", {
      namespace: "hud",
      root_panel: {
        type: "panel",
        controls: [
          { one: { type: "label" } },
          { two: { type: "label" } },
          { three: { type: "label" } },
        ],
      },
    }),
    src("server", "ui/hud.json", {
      namespace: "hud",
      root_panel: {
        modifications: [
          {
            array_name: "controls",
            operation: "insert_back",
            value: [{ four: { type: "image" } }],
          },
          {
            control_name: "two",
            operation: "replace",
            value: [{ two_b: { type: "image" } }],
          },
          {
            control_name: "three",
            operation: "remove",
          },
        ],
      },
    }),
  ]);
  const el = r.resolve("hud", "root_panel");
  assert.deepEqual(
    el!.controls.map((c) => c.id),
    ["one", "two_b", "four"],
  );
  assert.equal(el!.controls[1]!.element.type, "image");
  assert.equal(el!.controls[2]!.element.type, "image");
});

test("modifications: insert_front", () => {
  const r = buildResolver([
    src("v", "ui/a.json", {
      namespace: "ns",
      root: {
        type: "panel",
        controls: [{ a: { type: "label" } }],
      },
    }),
    src("s", "ui/a.json", {
      namespace: "ns",
      root: {
        modifications: [
          {
            array_name: "controls",
            operation: "insert_front",
            value: [{ z: { type: "image" } }],
          },
        ],
      },
    }),
  ]);
  assert.deepEqual(
    r.resolve("ns", "root")!.controls.map((c) => c.id),
    ["z", "a"],
  );
});

test("REAL-FILE smoke: resolve hud.hud_screen from vanilla fixtures", () => {
  const hudText = readFileSync(
    join(fixtures, "vanilla/hud_screen.json"),
    "utf8",
  );
  const commonText = readFileSync(
    join(fixtures, "vanilla/ui_common.json"),
    "utf8",
  );
  const hud = parseLooseJson(hudText, "hud_screen.json");
  const common = parseLooseJson(commonText, "ui_common.json");
  const r = buildResolver([
    src("vanilla", "ui/ui_common.json", common),
    src("vanilla", "ui/hud_screen.json", hud),
  ]);
  const el = r.resolve("hud", "hud_screen");
  assert.ok(el, "hud_screen should resolve");
  assert.equal(el!.type, "screen");
  assert.ok(el!.controls.length > 0, "hud_screen should have controls");
  // $screen_content → hud.hud_content should appear as a resolved child somewhere
  const ids = el!.controls.map((c) => c.id);
  assert.ok(
    ids.includes("variables_button_mappings_and_controls") ||
      ids.some((id) => id.includes("screen")),
    `expected base_screen controls, got ${ids.slice(0, 5).join(",")}`,
  );
});

test("globals fallback: $var only defined in globals", () => {
  const r = buildResolver(
    [
      src("v", "ui/a.json", {
        namespace: "ns",
        label: {
          type: "label",
          text: "$greet",
          color: "$local",
          $local: [1, 1, 1],
        },
      }),
    ],
    { $greet: "hello-global" },
  );
  const el = r.resolve("ns", "label");
  assert.ok(el);
  assert.equal(el!.props.text, "hello-global");
  assert.deepEqual(el!.props.color, [1, 1, 1]);
});

test("globals are lowest precedence vs element $var", () => {
  const r = buildResolver(
    [
      src("v", "ui/a.json", {
        namespace: "ns",
        label: {
          type: "label",
          text: "$greet",
          $greet: "from-element",
        },
      }),
    ],
    { $greet: "from-global" },
  );
  assert.equal(r.resolve("ns", "label")!.props.text, "from-element");
});

test("REAL-FILE smoke: sidebar $string_parser from pokebedrock globals", () => {
  const globals = parseLooseJson<Record<string, unknown>>(
    readFileSync(join(fixtures, "pokebedrock/_global_variables.json"), "utf8"),
  );
  const sidebar = parseLooseJson(
    readFileSync(join(fixtures, "pokebedrock/phud/sidebar.json"), "utf8"),
  );
  const expectedParser = globals.$string_parser;
  assert.equal(typeof expectedParser, "string");

  const r = buildResolver(
    [src("pokebedrock", "ui/phud/sidebar.json", sidebar)],
    globals,
  );
  const el = r.resolve("phud_sidebar", "variable_parser");
  assert.ok(el, "variable_parser should resolve");
  const binding = el!.bindings.find((b) => b.target_property_name === "#var");
  assert.ok(binding, "expected #var binding");
  assert.equal(binding!.source_property_name, expectedParser);
  assert.notEqual(binding!.source_property_name, "$string_parser");
});

test("pokebedrock sidebar fixture parses", () => {
  const text = readFileSync(
    join(fixtures, "pokebedrock/phud/sidebar.json"),
    "utf8",
  );
  const doc = parseLooseJson(text);
  const raw = parseUiRawFile(doc);
  assert.ok(raw);
  assert.ok(Object.keys(raw!.elements).length > 0);
});

test("sidebar $var_index aliases resolve to numeric field indices", () => {
  const globals = parseLooseJson<Record<string, unknown>>(
    readFileSync(join(fixtures, "pokebedrock/_global_variables.json"), "utf8"),
  );
  const sidebar = parseLooseJson(
    readFileSync(join(fixtures, "pokebedrock/phud/sidebar.json"), "utf8"),
  );
  const r = buildResolver(
    [src("pokebedrock", "ui/phud/sidebar.json", sidebar)],
    globals,
  );
  const main = r.resolve("phud_sidebar", "main");
  assert.ok(main);
  const dock = main!.controls.find((c) => c.id === "dock")!.element;
  const holder = dock.controls.find((c) => c.id === "pokemon_holder")!.element;
  const p1 = holder.controls.find((c) => c.id === "pokemon1")!.element;
  const p3 = holder.controls.find((c) => c.id === "pokemon3")!.element;
  const data1 = p1.controls.find((c) => c.id === "pokemon_data")!.element;
  const data3 = p3.controls.find((c) => c.id === "pokemon_data")!.element;
  assert.equal(data1.props.$var_index, 2);
  assert.equal(data3.props.$var_index, 16);
  assert.notEqual(data1.props.$var_index, "$pokemon_id_index");
});
