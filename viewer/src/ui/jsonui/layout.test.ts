/**
 * Pure layout tests — no loader, no DOM.
 *
 * Run: `cd viewer ; npx tsx --test src/ui/jsonui/layout.test.ts`
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layoutTree, type LayoutNode, type MeasureText } from "./layout";
import type { PropertyBag, ResolvedChild, ResolvedElement } from "./types";

const VP = { width: 200, height: 100 };

const measureStub: MeasureText = (text, fontScale) => ({
  w: text.length * 6 * fontScale,
  h: 8 * fontScale,
});

function el(
  type: string,
  props: PropertyBag = {},
  controls: ResolvedChild[] = [],
  name = type,
): ResolvedElement {
  return {
    type,
    name,
    namespace: "test",
    props,
    controls,
    bindings: [],
  };
}

function child(id: string, element: ResolvedElement): ResolvedChild {
  return { id, element };
}

function boxOf(node: LayoutNode): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  return { ...node.box };
}

describe("layoutTree sizing", () => {
  it("resolves absolute px size with default center anchors", () => {
    const root = el("panel", { size: [40, 20] });
    const tree = layoutTree(root, VP, { measureText: measureStub });
    // center→center in 200×100 → top-left at (80, 40)
    assert.deepEqual(boxOf(tree), { x: 80, y: 40, w: 40, h: 20 });
  });

  it("resolves percent of parent", () => {
    const root = el(
      "panel",
      {
        size: ["100%", "100%"],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      [
        child(
          "a",
          el("panel", {
            size: ["50%", "25%"],
            anchor_from: "top_left",
            anchor_to: "top_left",
          }),
        ),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.deepEqual(boxOf(tree), { x: 0, y: 0, w: 200, h: 100 });
    assert.deepEqual(boxOf(tree.children[0]!), { x: 0, y: 0, w: 100, h: 25 });
  });

  it("resolves size-to-content %c via children", () => {
    const root = el(
      "panel",
      {
        size: ["100%c", "100%c"],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      [
        child(
          "a",
          el("panel", {
            size: [30, 10],
            anchor_from: "top_left",
            anchor_to: "top_left",
            offset: [0, 0],
          }),
        ),
        child(
          "b",
          el("panel", {
            size: [50, 12],
            anchor_from: "top_left",
            anchor_to: "top_left",
            offset: [10, 20],
          }),
        ),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    // child a: 0,0,30×10; child b: 10,20,50×12 → extent (60, 32)
    assert.deepEqual(boxOf(tree), { x: 0, y: 0, w: 60, h: 32 });
  });

  it("%c uses child AABB, not distance from parent origin", () => {
    // player_ping: Black tip sizes to 100%c + pad around a bottom-anchored row.
    const root = el(
      "panel",
      {
        size: ["100%c + 6px", "100%c + 2px"],
        anchor_from: "bottom_middle",
        anchor_to: "bottom_middle",
      },
      [
        child(
          "content",
          el("panel", {
            size: [80, 10],
            anchor_from: "bottom_middle",
            anchor_to: "bottom_middle",
          }),
        ),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.equal(tree.box.w, 86);
    assert.equal(tree.box.h, 12);
  });

  it("resolves %cm as max child", () => {
    const root = el(
      "panel",
      {
        size: ["100%cm", "100%cm"],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      [
        child(
          "a",
          el("panel", {
            size: [30, 40],
            anchor_from: "top_left",
            anchor_to: "top_left",
          }),
        ),
        child(
          "b",
          el("panel", {
            size: [50, 10],
            anchor_from: "top_left",
            anchor_to: "top_left",
          }),
        ),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.deepEqual(boxOf(tree), { x: 0, y: 0, w: 50, h: 40 });
  });

  it("evaluates arithmetic 100% - 8px", () => {
    const root = el("panel", {
      size: ["100% - 8px", "50% - 2px"],
      anchor_from: "top_left",
      anchor_to: "top_left",
    });
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.deepEqual(boxOf(tree), { x: 0, y: 0, w: 192, h: 48 });
  });

  it("clamps with min_size and max_size", () => {
    const root = el("panel", {
      size: [10, 10],
      min_size: [40, 30],
      max_size: [100, 100],
      anchor_from: "top_left",
      anchor_to: "top_left",
    });
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.deepEqual(boxOf(tree), { x: 0, y: 0, w: 40, h: 30 });

    const big = layoutTree(
      el("panel", {
        size: [500, 500],
        max_size: [80, 60],
        anchor_from: "top_left",
        anchor_to: "top_left",
      }),
      VP,
      { measureText: measureStub },
    );
    assert.deepEqual(boxOf(big), { x: 0, y: 0, w: 80, h: 60 });
  });

  it("sizes label via measureText when using %c", () => {
    const root = el("label", {
      text: "Hello", // 5 * 6 = 30 wide, h = 8
      size: ["100%c", "100%c"],
      font_scale_factor: 1,
      anchor_from: "top_left",
      anchor_to: "top_left",
    });
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.deepEqual(boxOf(tree), { x: 0, y: 0, w: 30, h: 8 });
  });

  it("applies font_scale_factor in measureText", () => {
    const root = el("label", {
      text: "AB",
      size: ["100%c", "100%c"],
      font_scale_factor: 2,
      anchor_from: "top_left",
      anchor_to: "top_left",
    });
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.deepEqual(boxOf(tree), { x: 0, y: 0, w: 24, h: 16 });
  });

  it("label default height is text metrics, not parent %", () => {
    const root = el(
      "panel",
      {
        size: [100, 80],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      [
        child(
          "lab",
          el("label", {
            text: "Hi",
            size: ["100%", "default"],
            anchor_from: "top_left",
            anchor_to: "top_left",
          }),
        ),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.deepEqual(boxOf(tree.children[0]!), { x: 0, y: 0, w: 100, h: 8 });
  });
});

describe("layoutTree anchors and offsets", () => {
  it("positions top_left", () => {
    const tree = layoutTree(
      el("panel", {
        size: [20, 10],
        anchor_from: "top_left",
        anchor_to: "top_left",
        offset: [5, 7],
      }),
      VP,
      { measureText: measureStub },
    );
    assert.deepEqual(boxOf(tree), { x: 5, y: 7, w: 20, h: 10 });
  });

  it("parses negative percent offsets (battle bag/run)", () => {
    const tree = layoutTree(
      el(
        "panel",
        {
          size: [200, 100],
          anchor_from: "top_left",
          anchor_to: "top_left",
        },
        [
          child(
            "bag",
            el("panel", {
              size: [40, 20],
              anchor_from: "top_left",
              anchor_to: "top_left",
              offset: ["-10%", "-13%"],
            }),
          ),
        ],
      ),
      VP,
      { measureText: measureStub },
    );
    // -10% of 200 = -20; -13% of 100 = -13
    assert.deepEqual(boxOf(tree.children[0]!), {
      x: -20,
      y: -13,
      w: 40,
      h: 20,
    });
  });

  it("keeps full-width center offset (battle move_selection host)", () => {
    // Pack: size 100%×100% + offset 55% — must not clamp back to x=0.
    const tree = layoutTree(
      el(
        "panel",
        {
          size: [200, 100],
          anchor_from: "top_left",
          anchor_to: "top_left",
        },
        [
          child(
            "move_selection_button",
            el("panel", {
              size: ["100%", "100%"],
              anchor_from: "center",
              anchor_to: "center",
              offset: ["55%", "20%"],
            }),
          ),
        ],
      ),
      VP,
      { measureText: measureStub },
    );
    // center in 200×100 + 55% of self width (110) → x=110 (not clamped to 0)
    const box = boxOf(tree.children[0]!);
    assert.equal(box.w, 200);
    assert.equal(box.h, 100);
    assert.ok(Math.abs(box.x - 110) < 0.01, `x=${box.x}`);
    assert.ok(Math.abs(box.y - 20) < 0.01, `y=${box.y}`);
  });

  it("positions center", () => {
    const tree = layoutTree(
      el("panel", {
        size: [40, 20],
        anchor_from: "center",
        anchor_to: "center",
        offset: [0, 0],
      }),
      VP,
      { measureText: measureStub },
    );
    assert.deepEqual(boxOf(tree), { x: 80, y: 40, w: 40, h: 20 });
  });

  it("positions bottom_right", () => {
    const tree = layoutTree(
      el("panel", {
        size: [40, 20],
        anchor_from: "bottom_right",
        anchor_to: "bottom_right",
        offset: [-4, -6],
      }),
      VP,
      { measureText: measureStub },
    );
    // parent BR (200,100) - self BR (40,20) + offset
    assert.deepEqual(boxOf(tree), { x: 156, y: 74, w: 40, h: 20 });
  });
});

describe("layoutTree stack_panel", () => {
  it("flows children vertically", () => {
    const root = el(
      "stack_panel",
      {
        orientation: "vertical",
        size: [100, 100],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      [
        child(
          "a",
          el("panel", {
            size: [100, 20],
          }),
        ),
        child(
          "b",
          el("panel", {
            size: [100, 30],
          }),
        ),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.deepEqual(boxOf(tree), { x: 0, y: 0, w: 100, h: 100 });
    assert.deepEqual(boxOf(tree.children[0]!), { x: 0, y: 0, w: 100, h: 20 });
    assert.deepEqual(boxOf(tree.children[1]!), { x: 0, y: 20, w: 100, h: 30 });
  });

  it("flows children horizontally", () => {
    const root = el(
      "stack_panel",
      {
        orientation: "horizontal",
        size: [200, 40],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      [
        child("a", el("panel", { size: [50, 40] })),
        child("b", el("panel", { size: [70, 40] })),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.deepEqual(boxOf(tree.children[0]!), { x: 0, y: 0, w: 50, h: 40 });
    assert.deepEqual(boxOf(tree.children[1]!), { x: 50, y: 0, w: 70, h: 40 });
  });

  it("gives remaining main-axis space to fill children", () => {
    const root = el(
      "stack_panel",
      {
        orientation: "vertical",
        size: [80, 100],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      [
        child("a", el("panel", { size: [80, 20] })),
        child("b", el("panel", { size: [80, "fill"] })),
        child("c", el("panel", { size: [80, 10] })),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.equal(tree.children[0]!.box.h, 20);
    assert.equal(tree.children[1]!.box.h, 70); // 100 - 20 - 10
    assert.equal(tree.children[2]!.box.h, 10);
    assert.equal(tree.children[1]!.box.y, 20);
    assert.equal(tree.children[2]!.box.y, 90);
  });

  it("sizes stack to content with %c", () => {
    const root = el(
      "stack_panel",
      {
        orientation: "vertical",
        size: ["100%c", "100%c"],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      [
        child("a", el("panel", { size: [40, 10] })),
        child("b", el("panel", { size: [30, 15] })),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.deepEqual(boxOf(tree), { x: 0, y: 0, w: 40, h: 25 });
  });
});

describe("layoutTree layer and visibility", () => {
  it("records layer on nodes", () => {
    const root = el(
      "panel",
      {
        size: ["100%", "100%"],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      [
        child(
          "low",
          el("panel", {
            size: [10, 10],
            layer: 0,
            anchor_from: "top_left",
            anchor_to: "top_left",
          }),
        ),
        child(
          "high",
          el("panel", {
            size: [10, 10],
            layer: 5,
            anchor_from: "top_left",
            anchor_to: "top_left",
            offset: [5, 5],
          }),
        ),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.equal(tree.children[0]!.layer, 0);
    assert.equal(tree.children[1]!.layer, 5);
  });

  it("keeps visible:false nodes flagged", () => {
    const root = el(
      "panel",
      {
        size: ["100%", "100%"],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      [
        child(
          "hid",
          el("panel", {
            size: [10, 10],
            visible: false,
            anchor_from: "top_left",
            anchor_to: "top_left",
          }),
        ),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.equal(tree.children.length, 1);
    assert.equal(tree.children[0]!.visible, false);
    // Invisible trees are stubbed (0×0, no children) — full layout is skipped.
    assert.deepEqual(boxOf(tree.children[0]!), { x: 0, y: 0, w: 0, h: 0 });
    assert.equal(tree.children[0]!.children.length, 0);
  });
});

describe("layoutTree grid placement", () => {
  it("places children in a uniform grid", () => {
    const root = el(
      "grid",
      {
        size: [100, 60],
        grid_dimensions: [2, 2],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      [
        child(
          "a",
          el("panel", {
            size: ["100%", "100%"],
            anchor_from: "top_left",
            anchor_to: "top_left",
          }),
        ),
        child(
          "b",
          el("panel", {
            size: ["100%", "100%"],
            anchor_from: "top_left",
            anchor_to: "top_left",
          }),
        ),
        child(
          "c",
          el("panel", {
            size: ["100%", "100%"],
            anchor_from: "top_left",
            anchor_to: "top_left",
          }),
        ),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.deepEqual(boxOf(tree.children[0]!), { x: 0, y: 0, w: 50, h: 30 });
    assert.deepEqual(boxOf(tree.children[1]!), { x: 50, y: 0, w: 50, h: 30 });
    assert.deepEqual(boxOf(tree.children[2]!), { x: 0, y: 30, w: 50, h: 30 });
  });
});

describe("layoutTree self-axis %x/%y", () => {
  it("resolves width as % of own height (%y)", () => {
    // Sidebar main: ["222.22%y", 192] → w = 2.2222 * 192.
    const tree = layoutTree(
      el("panel", {
        size: ["222.22%y", 192],
        anchor_from: "top_left",
        anchor_to: "top_left",
      }),
      VP,
      { measureText: measureStub },
    );
    assert.equal(tree.box.h, 192);
    assert.ok(Math.abs(tree.box.w - 2.2222 * 192) < 0.01);
  });

  it("caps right-anchored phud_sidebar.main at 35% viewport width", () => {
    // Capture frames are ~640gui wide; authored 427gui main + dock offset
    // painted the tall black slab. Clamp keeps plate art on-screen.
    const wide = { width: 640, height: 360 };
    const main: ResolvedElement = {
      type: "panel",
      name: "main",
      namespace: "phud_sidebar",
      props: {
        size: ["222.22%y", 192],
        anchor_from: "top_right",
        anchor_to: "top_right",
      },
      controls: [],
      bindings: [],
    };
    const tree = layoutTree(main, wide, { measureText: measureStub });
    assert.equal(tree.box.h, 192);
    assert.ok(tree.box.w <= wide.width * 0.35 + 0.5);
    assert.ok(tree.box.x + tree.box.w <= wide.width - 1);
  });

  it("makes square icons with [100%y, 100%]", () => {
    const root = el(
      "panel",
      {
        size: [80, 32],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      [
        child(
          "ball",
          el("image", {
            size: ["100%y", "100%"],
            anchor_from: "top_left",
            anchor_to: "top_left",
          }),
        ),
      ],
    );
    const tree = layoutTree(root, VP, { measureText: measureStub });
    assert.deepEqual(boxOf(tree.children[0]!), { x: 0, y: 0, w: 32, h: 32 });
  });
});

describe("layoutTree grid", () => {
  it("sizes 100%c height from rows × item height (starter picker)", () => {
    const items: ResolvedChild[] = [];
    for (let i = 0; i < 12; i++) {
      items.push(
        child(
          `b${i}`,
          el("panel", {
            size: ["15%", 30],
            anchor_from: "top_middle",
            anchor_to: "top_middle",
            collection_index: i,
          }),
        ),
      );
    }
    const root = el(
      "grid",
      {
        size: ["100%", "100%c"],
        grid_dimensions: [6, 2],
        anchor_from: "top_left",
        anchor_to: "top_left",
      },
      items,
      "picker_panel_grid",
    );
    const tree = layoutTree(
      root,
      { width: 600, height: 400 },
      {
        measureText: measureStub,
      },
    );
    // 2 rows × 30px item height — must not collapse to 0.
    assert.equal(tree.box.h, 60);
    assert.equal(tree.box.w, 600);
    // Item width 15% of grid → ~90% of cell (cell = 100px) → ~90px.
    assert.ok(
      tree.children[0]!.box.w > 50,
      `cell item w=${tree.children[0]!.box.w}`,
    );
    assert.equal(tree.children[0]!.box.h, 30);
    // Second row drops below the first.
    assert.ok(tree.children[6]!.box.y > tree.children[0]!.box.y);
  });
});
