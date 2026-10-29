/**
 * Live viewer draws the face toward a column that has not arrived yet, so
 * the frontier stays visible until the neighbour lands. Film snapshots never
 * receive those columns later — the face is a grass or water wall in the
 * middle of the shot. Hide it and the hole is sky.
 */
export type UnloadedColumnPolicy = "expose" | "hide";

/** Neighbour cell whose column/section was never delivered. Not air. */
export const UNLOADED_NEIGHBOUR = Symbol("unloaded-neighbour");

export type ColumnLoadState = "requested" | "partial" | "complete";

/**
 * Decide what a neighbour probe should do.
 *
 * A complete column with no section is air (the encoder omits air-only
 * sections). A requested or partial column with a section has real blocks
 * and must be read. A requested or partial column with no section, or no
 * column at all, is unloaded.
 *
 * @param columnState - Column receipt, or undefined when the column is absent.
 * @param sectionPresent - The neighbour section is in the snapshot.
 * @param policy - Expose the frontier, or hide it.
 * @returns `read` the palette, treat as `air`, or `unloaded`.
 */
export function neighbourDisposition(
  columnState: ColumnLoadState | undefined,
  sectionPresent: boolean,
  policy: UnloadedColumnPolicy,
): "read" | "air" | "unloaded" {
  if (columnState === undefined) {
    return policy === "hide" ? "unloaded" : "air";
  }
  if (columnState === "complete") {
    return sectionPresent ? "read" : "air";
  }
  if (sectionPresent) return "read";
  return policy === "hide" ? "unloaded" : "air";
}
