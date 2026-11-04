import assert from "node:assert/strict";
import { test } from "node:test";
import { cornerUvSigns } from "./mesher";
test("AO sampling follows world-space corners on all six faces", () => {
  const corners = [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    [
      [1, 0],
      [0, 0],
      [0, 1],
      [1, 1],
    ],
    [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    [
      [1, 0],
      [0, 0],
      [0, 1],
      [1, 1],
    ],
  ];
  for (let dir = 0; dir < 6; dir++) {
    assert.deepEqual(
      cornerUvSigns(dir as 0 | 1 | 2 | 3 | 4 | 5, 1, 1),
      corners[dir]!.map(([u, v]) => [u! * 2 - 1, v! * 2 - 1]),
      `face ${dir}`,
    );
  }
});
