import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyBindings } from "./bindings.js";
import type { BindingSource, PropertyBag, ResolvedElement } from "./types.js";

function el(bindings: PropertyBag[], props: PropertyBag = {}): ResolvedElement {
  return {
    type: "label",
    name: "test",
    namespace: "test",
    props,
    controls: [],
    bindings,
  };
}

function source(map: Record<string, string | number | boolean>): BindingSource {
  return {
    global(name: string) {
      if (name in map) return map[name];
      const bare = name.startsWith("#") ? name.slice(1) : name;
      if (bare in map) return map[bare];
      const hashed = name.startsWith("#") ? name : `#${name}`;
      return map[hashed];
    },
  };
}

describe("applyBindings global", () => {
  it("copies binding_name → binding_name_override", () => {
    const out: PropertyBag = {};
    applyBindings(
      el([
        {
          binding_name: "#hud_title_text_string",
          binding_name_override: "#text",
          binding_type: "global",
        },
      ]),
      source({ "#hud_title_text_string": "Hello" }),
      out,
    );
    assert.equal(out.text, "Hello");
  });

  it("defaults binding_type to global", () => {
    const out: PropertyBag = {};
    applyBindings(
      el([
        { binding_name: "#hotbar_visible", binding_name_override: "#visible" },
      ]),
      source({ "#hotbar_visible": true }),
      out,
    );
    assert.equal(out.visible, true);
  });
});

describe("applyBindings view", () => {
  it("evaluates source_property_name into target_property_name", () => {
    const out: PropertyBag = { string: "abcdef" };
    applyBindings(
      el([
        {
          binding_name: "#null",
          binding_type: "view",
          source_property_name: "('%.4s' * #string)",
          target_property_name: "#text",
        },
      ]),
      source({}),
      out,
    );
    assert.equal(out.text, "abcd");
  });

  it("expands bare $string_parser variable then evaluates", () => {
    const STRING_PARSER =
      "((('%.' + $var_size + 's') * (#string - (('%.' + ($var_size * $var_index) + 's') * #string))) - '|')";
    const pad120 = (s: string) => s.padEnd(120, " ").slice(0, 120);
    const packed = `${pad120("stats")}|${pad120("Name")}`;

    const out: PropertyBag = { string: packed };
    applyBindings(
      el(
        [
          {
            binding_name: "#null",
            binding_type: "view",
            source_property_name: "$string_parser",
            target_property_name: "#var",
          },
        ],
        {
          $string_parser: STRING_PARSER,
          $var_size: 121,
          $var_index: 1,
        },
      ),
      source({}),
      out,
    );
    assert.equal(out.var, pad120("Name"));
  });

  it("visibility from comparison", () => {
    const out: PropertyBag = { sidebar: "payload" };
    applyBindings(
      el([
        {
          binding_name: "#null",
          binding_type: "view",
          source_property_name: "(not (#sidebar = ''))",
          target_property_name: "#visible",
          binding_condition: "always",
        },
      ]),
      source({}),
      out,
    );
    assert.equal(out.visible, true);

    const empty: PropertyBag = { sidebar: "" };
    applyBindings(
      el([
        {
          binding_name: "#null",
          binding_type: "view",
          source_property_name: "(not (#sidebar = ''))",
          target_property_name: "#visible",
        },
      ]),
      source({}),
      empty,
    );
    assert.equal(empty.visible, false);
  });

  it("uses lookup callback for sibling/parent scope", () => {
    const out: PropertyBag = {};
    applyBindings(
      el([
        {
          binding_name: "#null",
          binding_type: "view",
          source_control_name: "elements",
          source_property_name: "#sidebar",
          target_property_name: "#string",
        },
      ]),
      source({}),
      out,
      { lookup: (n) => (n === "sidebar" ? "from-parent" : undefined) },
    );
    assert.equal(out.string, "from-parent");
  });

  it("PokeBedrock &_ title suppress (hud_screen.json view binding)", () => {
    // Exact pack expression uses %.1s vs '&_' (1 char vs 2) — under char-truncate
    // semantics that never matches. Intended form is %.2s; assert that.
    const suppress = "(not ((%.2s * #hud_title_text_string ) = '&_'))";
    const out: PropertyBag = {};
    applyBindings(
      el([
        {
          binding_type: "global",
          binding_condition: "none",
          binding_name: "#hud_title_text_string",
          binding_name_override: "#hud_title_text_string",
        },
        {
          binding_name: "#null",
          binding_type: "view",
          source_property_name: suppress,
          target_property_name: "#visible",
        },
      ]),
      source({ "#hud_title_text_string": "&_sidebar:xxx" }),
      out,
    );
    assert.equal(out.hud_title_text_string, "&_sidebar:xxx");
    assert.equal(out.visible, false);

    const visibleOut: PropertyBag = {};
    applyBindings(
      el([
        {
          binding_type: "global",
          binding_name: "#hud_title_text_string",
          binding_name_override: "#hud_title_text_string",
        },
        {
          binding_name: "#null",
          binding_type: "view",
          source_property_name: suppress,
          target_property_name: "#visible",
        },
      ]),
      source({ "#hud_title_text_string": "Level Up!" }),
      visibleOut,
    );
    assert.equal(visibleOut.visible, true);
  });
});
