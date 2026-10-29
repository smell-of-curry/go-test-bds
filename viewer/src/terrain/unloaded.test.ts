/**
 * Film must not build a wall toward a column that never arrived.
 *
 * Run: `cd viewer && npx tsx --test src/terrain/unloaded.test.ts`
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { neighbourDisposition } from "./unloaded";

describe("unloaded neighbour columns", () => {
  it("film hides a missing or empty requested column; live still exposes it", () => {
    assert.equal(neighbourDisposition(undefined, false, "hide"), "unloaded");
    assert.equal(neighbourDisposition(undefined, false, "expose"), "air");
    assert.equal(neighbourDisposition("requested", false, "hide"), "unloaded");
    assert.equal(neighbourDisposition("requested", false, "expose"), "air");
    assert.equal(neighbourDisposition("partial", false, "hide"), "unloaded");
  });

  it("reads a requested column once its section is in the snapshot", () => {
    assert.equal(neighbourDisposition("requested", true, "hide"), "read");
    assert.equal(neighbourDisposition("requested", true, "expose"), "read");
  });

  it("treats a missing section of a complete column as air", () => {
    assert.equal(neighbourDisposition("complete", false, "hide"), "air");
    assert.equal(neighbourDisposition("complete", true, "hide"), "read");
  });
});
