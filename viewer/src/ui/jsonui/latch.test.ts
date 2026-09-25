/**
 * Cross-frame latch: preserved_text survives a later title that does not
 * match the element's `$update_string`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyBindings } from "./bindings";
import type { BindingSource, PropertyBag, ResolvedElement } from "./types";

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
 * Mimic the runtime latch for one control across two titles.
 *
 * @param el - Element with `$update_string`.
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
  assert.ok(update);

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

describe("title latch across frames", () => {
  it("keeps the first matching title after a different token arrives", () => {
    const el: ResolvedElement = {
      type: "panel",
      name: "data_control",
      namespace: "widgets",
      props: { $update_string: "@@side:" },
      controls: [],
      bindings: [
        {
          binding_condition: "visibility_changed",
          binding_name_override: "#preserved_text",
          binding_name: "#hud_title_text_string",
        },
      ],
    };
    const kept = latchAcross(el, "@@side:X", "@@phone:ring");
    assert.equal(kept, "@@side:X");
  });
});
