import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  loadUiFileSet,
  localizeLabelText,
  parseLangFile,
  parseLooseJson,
  parseUiRawFile,
  type UiLoadClient,
} from "./load";
import { createFixtureUiClient } from "./fixtureClient";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../testdata/jsonui");

test("parseLooseJson: // comments + trailing commas + BOM", () => {
  const text =
    '\uFEFF{\n  // hello\n  "namespace": "x",\n  "a": { "b": 1, },\n}\n';
  const doc = parseLooseJson<Record<string, unknown>>(text);
  assert.equal(doc.namespace, "x");
  assert.deepEqual(doc.a, { b: 1 });
});

test("parseLooseJson: block comments", () => {
  const doc = parseLooseJson<{ n: number }>('{ /* x */ "n": 2 }');
  assert.equal(doc.n, 2);
});

test("parseUiRawFile: namespace + elements", () => {
  const raw = parseUiRawFile({
    namespace: "hud",
    "root@common.base": { type: "panel" },
    skip: "nope",
  });
  assert.ok(raw);
  assert.equal(raw!.namespace, "hud");
  assert.deepEqual(raw!.elements["root@common.base"], { type: "panel" });
  assert.equal(raw!.elements.skip, undefined);
});

test("loadUiFileSet: unions defs, per-pack fetch, pack order", async () => {
  const store = new Map<string, unknown>([
    [
      "vanilla:ui/_ui_defs.json",
      { ui_defs: ["ui/hud_screen.json", "ui/ui_common.json"] },
    ],
    [
      "server:ui/_ui_defs.json",
      { ui_defs: ["ui/hud_screen.json", "ui/phud/sidebar.json"] },
    ],
    [
      "vanilla:ui/hud_screen.json",
      { namespace: "hud", root_panel: { type: "panel", $v: 1 } },
    ],
    [
      "server:ui/hud_screen.json",
      {
        namespace: "hud",
        root_panel: {
          modifications: [
            {
              array_name: "controls",
              operation: "insert_back",
              value: [{ "extra@extra": {} }],
            },
          ],
        },
      },
    ],
    [
      "vanilla:ui/ui_common.json",
      { namespace: "common", base: { type: "panel" } },
    ],
    [
      "server:ui/phud/sidebar.json",
      { namespace: "sidebar", main: { type: "panel" } },
    ],
  ]);

  const client: UiLoadClient = {
    async getPacks() {
      return [
        { id: "server", priority: 1 },
        { id: "vanilla", priority: 0 },
      ];
    },
    async fetchPackJson(packId, path) {
      return (store.get(`${packId}:${path}`) as never) ?? null;
    },
    async fetchPackText() {
      return null;
    },
  };

  const { files, globals, lang } = await loadUiFileSet(client);
  const paths = files.map((f) => `${f.packId}:${f.path}`);
  assert.deepEqual(paths, [
    "vanilla:ui/hud_screen.json",
    "vanilla:ui/ui_common.json",
    "server:ui/hud_screen.json",
    "server:ui/phud/sidebar.json",
  ]);
  assert.equal(files[0]!.raw.namespace, "hud");
  assert.equal(files[3]!.raw.namespace, "sidebar");
  assert.deepEqual(globals, {});
  assert.deepEqual(lang, {});
});

test("loadUiFileSet: skips missing pack files", async () => {
  const client: UiLoadClient = {
    async getPacks() {
      return [{ id: "a", priority: 0 }];
    },
    async fetchPackJson<T = unknown>(
      _packId: string,
      path: string,
    ): Promise<T | null> {
      if (path === "ui/_ui_defs.json") {
        return { ui_defs: ["ui/missing.json", "ui/ok.json"] } as T;
      }
      if (path === "ui/ok.json") {
        return { namespace: "ok", e: { type: "label" } } as T;
      }
      return null;
    },
    async fetchPackText() {
      return null;
    },
  };
  const { files, globals } = await loadUiFileSet(client);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, "ui/ok.json");
  assert.deepEqual(globals, {});
});

test("loadUiFileSet: globals merge, later pack wins", async () => {
  const client: UiLoadClient = {
    async getPacks() {
      return [
        { id: "vanilla", priority: 0 },
        { id: "server", priority: 1 },
      ];
    },
    async fetchPackJson<T = unknown>(
      packId: string,
      path: string,
    ): Promise<T | null> {
      if (path === "ui/_global_variables.json") {
        if (packId === "vanilla") {
          return {
            $shared: "vanilla",
            $only_vanilla: 1,
          } as T;
        }
        return {
          $shared: "server",
          $string_parser: "expr",
        } as T;
      }
      if (path === "ui/_ui_defs.json") return { ui_defs: [] } as T;
      return null;
    },
    async fetchPackText() {
      return null;
    },
  };
  const { files, globals } = await loadUiFileSet(client);
  assert.equal(files.length, 0);
  assert.equal(globals.$shared, "server");
  assert.equal(globals.$only_vanilla, 1);
  assert.equal(globals.$string_parser, "expr");
});

test("parseLooseJson: real vanilla _ui_defs fixture", () => {
  const text = readFileSync(join(fixtures, "vanilla/_ui_defs.json"), "utf8");
  const doc = parseLooseJson<{ ui_defs: string[] }>(text);
  assert.ok(Array.isArray(doc.ui_defs));
  assert.ok(doc.ui_defs.some((p) => p.endsWith("hud_screen.json")));
});

test("parseLooseJson: real _global_variables fixtures", () => {
  const vanilla = parseLooseJson<Record<string, unknown>>(
    readFileSync(join(fixtures, "vanilla/_global_variables.json"), "utf8"),
  );
  const poke = parseLooseJson<Record<string, unknown>>(
    readFileSync(join(fixtures, "pokebedrock/_global_variables.json"), "utf8"),
  );
  assert.ok(typeof vanilla.$generic_button_text_color !== "undefined");
  assert.equal(typeof poke.$string_parser, "string");
  assert.ok((poke.$string_parser as string).includes("$var_size"));
});

test("parseLangFile: comments, tab trailers, CRLF", () => {
  const text =
    "## section\r\n" +
    "# line comment\r\n" +
    "a=one\r\n" +
    "b=two\t# trail\r\n" +
    "c=keep space \r\n" +
    "\r\n" +
    "d=##not a comment value\r\n";
  assert.deepEqual(parseLangFile(text), {
    a: "one",
    b: "two",
    c: "keep space ",
    d: "##not a comment value",
  });
});

test("localizeLabelText: localize true hits / miss unchanged", () => {
  const lang = { "phud.playerPing.label": "Current Ping: " };
  assert.equal(
    localizeLabelText("phud.playerPing.label", true, lang),
    "Current Ping: ",
  );
  assert.equal(localizeLabelText("missing.key", true, lang), "missing.key");
  assert.equal(
    localizeLabelText("phud.playerPing.label", false, lang),
    "phud.playerPing.label",
  );
});

test("loadUiFileSet: lang merge, later pack wins, 404 ok", async () => {
  const client: UiLoadClient = {
    async getPacks() {
      return [
        { id: "vanilla", priority: 0 },
        { id: "server", priority: 1 },
        { id: "empty", priority: 2 },
      ];
    },
    async fetchPackJson<T = unknown>(
      _packId: string,
      path: string,
    ): Promise<T | null> {
      if (path === "ui/_ui_defs.json") return { ui_defs: [] } as T;
      return null;
    },
    async fetchPackText(packId: string, path: string): Promise<string | null> {
      if (path !== "texts/en_US.lang") return null;
      if (packId === "vanilla") return "shared=vanilla\nonly_v=1\n";
      if (packId === "server") return "shared=server\nping=Current Ping: \n";
      return null;
    },
  };
  const { lang } = await loadUiFileSet(client);
  assert.equal(lang.shared, "server");
  assert.equal(lang.only_v, "1");
  assert.equal(lang.ping, "Current Ping: ");
});

test("loadUiFileSet: real fixture lang override order", async () => {
  const { lang } = await loadUiFileSet(createFixtureUiClient(fixtures));
  assert.equal(lang["phud.playerPing.label"], "Current Ping: ");
  assert.equal(lang["fixture.shared"], "pokebedrock");
  assert.equal(lang["fixture.only_vanilla"], "only vanilla");
  assert.equal(lang["fixture.with_tab"], "hello");
});
