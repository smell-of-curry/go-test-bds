import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  countCollectionInstances,
  expandCollections,
  formButtonsCollection,
  prepareCollectionTree,
  readCollectionItem,
} from "./collections.js";
import { applyBindings } from "./bindings.js";
import type {
  BindingSource,
  PropertyBag,
  ResolvedElement,
  UiResolver,
} from "./types.js";

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

function panel(
  name: string,
  props: PropertyBag,
  controls: ResolvedElement["controls"] = [],
  bindings: PropertyBag[] = [],
): ResolvedElement {
  return {
    type: "stack_panel",
    name,
    namespace: "test",
    props,
    controls,
    bindings,
  };
}

describe("formButtonsCollection", () => {
  it("builds per-button text/texture items", () => {
    const items = formButtonsCollection(["a", "b"], ["t__1", ""]);
    assert.equal(items.length, 2);
    assert.equal(readCollectionItem(items[0]!, "#form_button_text"), "a");
    assert.equal(readCollectionItem(items[0]!, "#form_button_texture"), "t__1");
    assert.equal(readCollectionItem(items[1]!, "form_button_texture"), "");
  });
});

describe("expandCollections", () => {
  it("instantiates factory control_name once per item", () => {
    const template = panel(
      "btn",
      { size: ["100%", 20] },
      [],
      [
        {
          binding_type: "collection",
          binding_collection_name: "form_buttons",
          binding_name: "#form_button_text",
          binding_name_override: "#form_button_text",
        },
      ],
    );
    const host = panel(
      "host",
      {
        collection_name: "form_buttons",
        factory: { name: "buttons", control_name: "test.btn" },
      },
      [],
      [
        {
          binding_name: "#form_button_length",
          binding_name_override: "#collection_length",
        },
      ],
    );
    const resolver: UiResolver = {
      resolve(ns, name) {
        if (ns === "test" && name === "btn") return template;
        return undefined;
      },
      screens: () => [],
    };
    const items = formButtonsCollection(["one", "two", "three"]);
    const tree = prepareCollectionTree(
      host,
      resolver,
      source({ "#form_button_length": 3 }),
      { form_buttons: items },
    );
    assert.equal(countCollectionInstances(tree, "form_buttons"), 3);
    assert.equal(tree.controls[0]!.element.props.form_button_text, "one");
    assert.equal(tree.controls[1]!.element.props.form_button_text, "two");
    assert.equal(tree.controls[2]!.element.props.form_button_text, "three");
    assert.equal(tree.controls[0]!.element.props.collection_index, 0);
    assert.equal(tree.controls[2]!.element.props.collection_index, 2);
  });

  it("expand without bind leaves N children", () => {
    const template = panel("btn", {});
    const host = panel("host", {
      collection_name: "form_buttons",
      factory: { control_name: "test.btn" },
    });
    const resolver: UiResolver = {
      resolve: (ns, name) =>
        ns === "test" && name === "btn" ? template : undefined,
      screens: () => [],
    };
    const expanded = expandCollections(host, resolver, {
      form_buttons: formButtonsCollection(["a", "b"]),
    });
    assert.equal(expanded.controls.length, 2);
  });
});

describe("applyBindings collection", () => {
  it("writes collection item values when opts.collection set", () => {
    const out: PropertyBag = {};
    applyBindings(
      {
        type: "label",
        name: "t",
        namespace: "t",
        props: {},
        controls: [],
        bindings: [
          {
            binding_type: "collection",
            binding_collection_name: "form_buttons",
            binding_name: "#form_button_text",
            binding_name_override: "#text",
          },
          {
            binding_type: "collection_details",
            binding_collection_name: "form_buttons",
          },
        ],
      },
      source({}),
      out,
      {
        collectionIndex: 1,
        collection: (_c, name) =>
          name.includes("text") ? "move-b" : undefined,
      },
    );
    assert.equal(out.text, "move-b");
    assert.equal(out.collection_index, 1);
  });

  it("still skips collection without opts (compat)", () => {
    const out: PropertyBag = {};
    applyBindings(
      {
        type: "label",
        name: "t",
        namespace: "t",
        props: {},
        controls: [],
        bindings: [
          {
            binding_type: "collection",
            binding_collection_name: "form_buttons",
            binding_name: "#form_button_text",
            binding_name_override: "#text",
          },
        ],
      },
      source({ "#form_button_text": "nope" }),
      out,
    );
    assert.equal(out.text, undefined);
  });
});

describe("bindResolvedTree source_control_name", () => {
  it("shows icon panel when child image texture is non-empty", () => {
    const btn: ResolvedElement = {
      type: "stack_panel",
      name: "dynamic_button",
      namespace: "test",
      props: {
        collection_name: "form_buttons",
        factory: { control_name: "test.dynamic_button" },
      },
      bindings: [
        {
          binding_name: "#form_button_length",
          binding_name_override: "#collection_length",
        },
      ],
      controls: [],
    };
    const template: ResolvedElement = {
      type: "stack_panel",
      name: "dynamic_button",
      namespace: "test",
      props: {},
      bindings: [],
      controls: [
        {
          id: "panel_name",
          element: {
            type: "panel",
            name: "panel_name",
            namespace: "test",
            props: {},
            bindings: [
              {
                binding_name: "#null",
                binding_type: "view",
                source_control_name: "image",
                source_property_name: "(not (#texture = ''))",
                target_property_name: "#visible",
              },
            ],
            controls: [
              {
                id: "image",
                element: {
                  type: "image",
                  name: "image",
                  namespace: "test",
                  props: {},
                  bindings: [
                    {
                      binding_type: "collection",
                      binding_collection_name: "form_buttons",
                      binding_name: "#form_button_texture",
                      binding_name_override: "#texture",
                    },
                    {
                      binding_name: "#null",
                      binding_type: "view",
                      source_property_name:
                        "(not ((#texture = '') or (#texture = 'loading')))",
                      target_property_name: "#visible",
                    },
                  ],
                  controls: [],
                },
              },
            ],
          },
        },
      ],
    };
    const resolver: UiResolver = {
      resolve(ns, name) {
        if (ns === "test" && name === "dynamic_button") return template;
        return undefined;
      },
      screens: () => [],
    };
    const tree = prepareCollectionTree(
      btn,
      resolver,
      source({ "#form_button_length": 1 }),
      {
        form_buttons: formButtonsCollection(["HP"], ["textures/items/potion"]),
      },
    );
    const panel = tree.controls[0]!.element.controls[0]!.element;
    const image = panel.controls[0]!.element;
    assert.equal(image.props.texture, "textures/items/potion");
    assert.equal(image.props.visible, true);
    assert.equal(panel.props.visible, true);
  });
});
