import assert from "node:assert/strict";
import { test } from "node:test";
import { filmOutputSelection, parseFilmRanges } from "./render";
import { outputTimes } from "./time";

test("ranges concatenate exact frame grids while retaining source time across a long gap", () => {
  const got = filmOutputSelection(
    {
      ranges: [
        { from: "0s", to: "0.05s" },
        { from: "12000t", to: "12001t" },
      ],
      fps: 60,
    },
    10000,
  );
  assert.deepEqual(got, {
    fromMs: 0,
    toMs: 100050,
    times: [0, 17, 33, 100000, 100017, 100033],
    ranges: [
      { fromMs: 0, toMs: 50, fromFrame: 0, toFrame: 3 },
      { fromMs: 100000, toMs: 100050, fromFrame: 3, toFrame: 6 },
    ],
  });
  assert.equal(
    got.times[3]! - got.times[2]!,
    99967,
    "advance the source clock, not the output clock",
  );
});

test("adjacent ranges and fractional durations keep independent exact frame counts", () => {
  const got = filmOutputSelection(
    {
      ranges: [
        { from: 3, to: 3 + 110 / 60 },
        { from: 3 + 110 / 60, to: 3 + 249 / 60 },
      ],
      fps: 60,
    },
    0,
  );
  assert.equal(got.times.length, 249);
  assert.deepEqual(
    got.ranges.map((r) => [r.fromFrame, r.toFrame]),
    [
      [0, 110],
      [110, 249],
    ],
  );
  assert.equal(got.times[110], 4833);
  assert.ok(got.times.every((t, i) => i === 0 || t > got.times[i - 1]!));
});

test("single-window selection keeps the previous grid and before-start clamp", () => {
  for (const [from, to, expected] of [
    ["0.5s", "1s", outputTimes(500, 1000, 60)],
    ["98t", "102t", outputTimes(0, 100, 60)],
  ] as const) {
    const got = filmOutputSelection({ from, to, fps: 60 }, 100);
    assert.deepEqual(got.times, expected);
    assert.deepEqual(
      got.ranges.map((r) => [r.fromFrame, r.toFrame]),
      [[0, expected.length]],
    );
  }
});

test("range input rejects malformed JSON values rather than silently coercing them", () => {
  for (const value of [
    null,
    {},
    [],
    [null],
    [[]],
    [{ from: 0 }],
    [{ from: false, to: 1 }],
    [{ from: null, to: 1 }],
    [{ from: "", to: "1" }],
    [{ from: "s", to: "1s" }],
    [{ from: "0", to: "NaN" }],
    [{ from: 0, to: Infinity }],
    [{ from: [], to: 1 }],
    [{ from: "0", to: "1minute" }],
  ]) {
    assert.throws(() => parseFilmRanges(value), /range/);
  }
  assert.deepEqual(parseFilmRanges([{ from: " 1.5s ", to: "40tick" }]), [
    { from: " 1.5s ", to: "40tick" },
  ]);
});

test("range selection rejects overlap, reordering, empty windows and invalid clock bounds", () => {
  for (const ranges of [
    [
      { from: 0, to: 2 },
      { from: 1, to: 3 },
    ],
    [
      { from: 2, to: 3 },
      { from: 0, to: 1 },
    ],
    [{ from: 1, to: 1 }],
    [{ from: 2, to: 1 }],
    [{ from: 0, to: 0.001 }],
    [{ from: -1, to: 1 }],
    [{ from: "99t", to: "101t" }],
    [{ from: 0, to: 1e308 }],
  ]) {
    assert.throws(() => filmOutputSelection({ ranges, fps: 60 }, 100));
  }
  assert.throws(
    () => filmOutputSelection({ ranges: [{ from: 0, to: 1 }], fps: 0 }, 0),
    /bad fps/,
  );
  assert.throws(
    () =>
      filmOutputSelection(
        { from: "0", ranges: [{ from: 0, to: 1 }], fps: 60 },
        0,
      ),
    /cannot be combined/,
  );
  assert.throws(
    () => filmOutputSelection({ from: "0", fps: 60 }, 0),
    /provide from and to/,
  );
});
