import type { Block } from "../protocol";
import type { CrossQuad } from "./customGeometry";
import type { CubeModel } from "./types";

type Bounds = NonNullable<CubeModel["bounds"]>;

export function isGroundCover(name: string): boolean {
  return name === "minecraft:leaf_litter";
}

/** Native panes occupy a two-pixel strip, not a translucent full cube. */
export function applyThinBlockShape(block: Block, model: CubeModel): CubeModel {
  if (model.customGeometryKey) return model;
  if (isGroundCover(block.name)) {
    return { ...model, shape: "ground", ambientOcclusion: false };
  }
  if (!/^minecraft:(?:[a-z_]+_)?glass_pane$/.test(block.name)) return model;
  const lo = 7 / 16,
    hi = 9 / 16;
  const connected = (name: string) => {
    const value = block.states[`minecraft:connection_${name}`];
    return value === true || value === 1;
  };
  const n = connected("north"),
    s = connected("south");
  const e = connected("east"),
    w = connected("west");
  const boxes: Bounds[] = [];
  const boxFaces: CubeModel["faces"][] = [];
  const pane = model.faces.north;
  const edge =
    Object.values(model.faces).find((f) => f.texture.includes("pane_top")) ??
    pane;
  const add = (bounds: Bounds, axis: "x" | "z" | "post") => {
    boxes.push(bounds);
    const horizontal = { ...edge, rotation: (axis === "x" ? 1 : 0) as 0 | 1 };
    boxFaces.push({
      up: horizontal,
      down: horizontal,
      north: axis === "z" ? edge : pane,
      south: axis === "z" ? edge : pane,
      east: axis === "x" ? edge : pane,
      west: axis === "x" ? edge : pane,
    });
  };
  if (e || w) add([w ? 0 : lo, 0, lo, e ? 1 : hi, 1, hi], "x");
  if (n) add([lo, 0, 0, hi, 1, e || w ? lo : hi], "z");
  if (s) add([lo, 0, e || w || n ? hi : lo, hi, 1, 1], "z");
  // The isolated native pane remains a central post.
  if (!boxes.length) add([lo, 0, lo, hi, 1, hi], "post");
  return {
    ...model,
    boxes,
    boxFaces,
    renderClass: "translucent",
    ambientOcclusion: false,
  };
}

/** Leaf litter's growth fills successive quarters of a flat, rotated tile. */
export function groundCoverQuads(
  block: Block,
  x: number,
  y: number,
  z: number,
): CrossQuad[] {
  const count = Math.max(1, Math.min(4, Number(block.states.growth ?? 0) + 1));
  const directions = ["north", "east", "south", "west"];
  const turns = Math.max(
    0,
    directions.indexOf(
      String(block.states["minecraft:cardinal_direction"] ?? "north"),
    ),
  );
  const quarters = [
    [0, 0],
    [0, 0.5],
    [0.5, 0.5],
    [0.5, 0],
  ];
  return quarters.slice(0, count).map(([u, v]) => {
    const corners = [
      [u!, v!],
      [u! + 0.5, v!],
      [u! + 0.5, v! + 0.5],
      [u!, v! + 0.5],
    ];
    return {
      corners: corners.map(([cx, cz]) => {
        for (let i = 0; i < turns; i++) [cx, cz] = [1 - cz!, cx!];
        return [x + cx!, y + 1 / 64, z + cz!] as [number, number, number];
      }),
      uvs: corners.map(([cx, cz]) => [cx!, 1 - cz!] as [number, number]),
      doubleSided: true as const,
    };
  });
}
