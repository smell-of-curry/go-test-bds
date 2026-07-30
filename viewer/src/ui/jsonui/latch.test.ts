/**
 * Cross-frame PHUD latch: sidebar preserved_text survives a later phone token.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { applyBindings } from "./bindings";
import { createFixtureUiClient } from "./fixtureClient";
import { loadUiFileSet } from "./load";
import { buildResolver } from "./resolve";
import type { BindingSource, PropertyBag, ResolvedElement } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../../testdata/jsonui");

function source(title: string): BindingSource {
  return {
    global(name: string) {
      if (
        name === "#hud_title_text_string" ||
        name === "hud_title_text_string"
      ) {
        return title;
      }
      return undefined;
    },
  };
}

/**
 * Mimic runtime latch for one data_control instance across two titles.
 *
 * @param el - data_control element with $update_string.
 * @param title1 - First title.
 * @param title2 - Second title.
 * @returns preserved_text after both frames.
 */
function latchAcross(
  el: ResolvedElement,
  title1: string,
  title2: string,
): string {
  const update =
    typeof el.props.$update_string === "string" ? el.props.$update_string : "";
  assert.ok(update, "expected $update_string on data_control");

  let prev: PropertyBag = {};
  for (const title of [title1, title2]) {
    const out: PropertyBag = { ...el.props, ...prev };
    applyBindings(el, source(title), out, {
      lookup: (name) => {
        const fromOut = out[name] ?? out[`#${name}`];
        if (
          typeof fromOut === "string" ||
          typeof fromOut === "number" ||
          typeof fromOut === "boolean"
        ) {
          return fromOut;
        }
        const fromPrev = prev[name] ?? prev[`#${name}`];
        if (
          typeof fromPrev === "string" ||
          typeof fromPrev === "number" ||
          typeof fromPrev === "boolean"
        ) {
          return fromPrev;
        }
        return undefined;
      },
    });
    // Same as hud.applyVisibilityChangedLatch — undo always-apply overwrite.
    if (title.includes(update)) out.preserved_text = title;
    else if (typeof prev.preserved_text === "string") {
      out.preserved_text = prev.preserved_text;
    } else {
      delete out.preserved_text;
    }
    prev = { ...out };
  }
  return String(prev.preserved_text ?? "");
}

describe("PHUD latch across frames", () => {
  it("sidebar control keeps &_sidebar:X after &_phone:ring", async () => {
    const client = createFixtureUiClient(fixtures);
    const { files, globals } = await loadUiFileSet(client);
    const r = buildResolver(files, globals);
    const phud = r.resolve("phud", "main");
    assert.ok(phud);
    const renderers = phud!.controls.find((c) => c.id === "renderers");
    assert.ok(renderers);
    const sidebarCtrl = renderers!.element.controls.find(
      (c) => c.id === "sidebar_control",
    );
    assert.ok(sidebarCtrl, "sidebar_control missing");

    const kept = latchAcross(
      sidebarCtrl!.element,
      "&_sidebar:X",
      "&_phone:ring",
    );
    assert.equal(kept, "&_sidebar:X");
  });
});
