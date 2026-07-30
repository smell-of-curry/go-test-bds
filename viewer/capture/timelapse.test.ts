// Unit tests for the pure timelapse computation (no ffmpeg involved).
// Run with: npm run test:capture (tsx --test, node:test runner).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSegmentPlan,
  capIntervals,
  computeMarkedIntervals,
  computeWalkIntervals,
  hasAllFilters,
  MIN_CUT_INTERVAL_MS,
  parseDurationMs,
  REQUIRED_FILTERS,
} from "./timelapse";

const start = (tMs: number) => ({ message: "walk:start", tMs });
const end = (tMs: number) => ({ message: "walk:end", tMs });
const loadStart = (tMs: number) => ({ message: "loading:start", tMs });
const loadEnd = (tMs: number) => ({ message: "loading:end", tMs });

test("computeWalkIntervals: simple pair", () => {
  assert.deepEqual(computeWalkIntervals([start(5000), end(20000)], 30000), [
    { startMs: 5000, endMs: 20000 },
  ]);
});

test("computeWalkIntervals: two disjoint legs stay disjoint", () => {
  assert.deepEqual(
    computeWalkIntervals(
      [start(1000), end(2000), start(8000), end(9000)],
      10000,
    ),
    [
      { startMs: 1000, endMs: 2000 },
      { startMs: 8000, endMs: 9000 },
    ],
  );
});

test("computeWalkIntervals: nested starts merge into the outer leg", () => {
  assert.deepEqual(
    computeWalkIntervals(
      [start(1000), start(2000), end(3000), end(6000)],
      10000,
    ),
    [{ startMs: 1000, endMs: 6000 }],
  );
});

test("computeWalkIntervals: overlapping legs merge", () => {
  // start A, start B, end A, end B — one continuous walking stretch.
  assert.deepEqual(
    computeWalkIntervals(
      [start(1000), start(4000), end(5000), end(8000)],
      10000,
    ),
    [{ startMs: 1000, endMs: 8000 }],
  );
});

test("computeWalkIntervals: stray walk:end is ignored", () => {
  assert.deepEqual(
    computeWalkIntervals([end(500), start(5000), end(6000)], 10000),
    [{ startMs: 5000, endMs: 6000 }],
  );
});

test("computeWalkIntervals: unmatched walk:start closes at video end", () => {
  assert.deepEqual(computeWalkIntervals([start(7000)], 10000), [
    { startMs: 7000, endMs: 10000 },
  ]);
});

test("computeWalkIntervals: clamps to the video and drops out-of-range marks", () => {
  assert.deepEqual(
    computeWalkIntervals(
      [start(-2000), end(3000), start(11000), end(12000)],
      10000,
    ),
    [{ startMs: 0, endMs: 3000 }],
  );
});

test("computeWalkIntervals: sub-minimum intervals are dropped", () => {
  assert.deepEqual(computeWalkIntervals([start(1000), end(1100)], 10000), []);
});

test("computeWalkIntervals: unsorted marks are sorted first", () => {
  assert.deepEqual(computeWalkIntervals([end(20000), start(5000)], 30000), [
    { startMs: 5000, endMs: 20000 },
  ]);
});

test("computeMarkedIntervals: walk and loading side by side", () => {
  assert.deepEqual(
    computeMarkedIntervals(
      [start(1000), end(3000), loadStart(5000), loadEnd(9000)],
      10000,
    ),
    [
      { startMs: 1000, endMs: 3000, kind: "walk" },
      { startMs: 5000, endMs: 9000, kind: "loading" },
    ],
  );
});

test("computeMarkedIntervals: loading wins overlap inside a walk", () => {
  assert.deepEqual(
    computeMarkedIntervals(
      [start(0), loadStart(3000), loadEnd(7000), end(10000)],
      10000,
    ),
    [
      { startMs: 0, endMs: 3000, kind: "walk" },
      { startMs: 3000, endMs: 7000, kind: "loading" },
      { startMs: 7000, endMs: 10000, kind: "walk" },
    ],
  );
});

test("computeMarkedIntervals: stray loading:end is ignored", () => {
  assert.deepEqual(
    computeMarkedIntervals(
      [loadEnd(500), loadStart(2000), loadEnd(5000)],
      10000,
    ),
    [{ startMs: 2000, endMs: 5000, kind: "loading" }],
  );
});

test("computeMarkedIntervals: unmatched loading:start closes at video end", () => {
  assert.deepEqual(computeMarkedIntervals([loadStart(4000)], 10000), [
    { startMs: 4000, endMs: 10000, kind: "loading" },
  ]);
});

test("computeMarkedIntervals: sub-1s loading interval is kept (not cut)", () => {
  // Below MIN_CUT_INTERVAL_MS → dropped before the overlap pass, so a
  // surrounding walk stays continuous (no hole, no cut piece).
  assert.ok(MIN_CUT_INTERVAL_MS >= 1000);
  assert.deepEqual(
    computeMarkedIntervals(
      [start(0), loadStart(4000), loadEnd(4500), end(10000)],
      10000,
    ),
    [{ startMs: 0, endMs: 10000, kind: "walk" }],
  );
  assert.deepEqual(
    computeMarkedIntervals([loadStart(4000), loadEnd(4500)], 10000),
    [],
  );
});

test("capIntervals: under the cap is untouched", () => {
  const ivs = [
    { startMs: 0, endMs: 1000 },
    { startMs: 5000, endMs: 6000 },
  ];
  assert.deepEqual(capIntervals(ivs, 5), ivs);
});

test("capIntervals: merges the pair with the smallest gap", () => {
  const ivs = [
    { startMs: 0, endMs: 1000 },
    { startMs: 1500, endMs: 2000 }, // 500ms gap to the left — merged first
    { startMs: 9000, endMs: 9500 },
  ];
  assert.deepEqual(capIntervals(ivs, 2), [
    { startMs: 0, endMs: 2000 },
    { startMs: 9000, endMs: 9500 },
  ]);
});

test("capIntervals: loading wins when merging mixed kinds", () => {
  const ivs = [
    { startMs: 0, endMs: 1000, kind: "walk" as const },
    { startMs: 1200, endMs: 2000, kind: "loading" as const },
    { startMs: 9000, endMs: 9500, kind: "walk" as const },
  ];
  assert.deepEqual(capIntervals(ivs, 2), [
    { startMs: 0, endMs: 2000, kind: "loading" },
    { startMs: 9000, endMs: 9500, kind: "walk" },
  ]);
});

test("buildSegmentPlan: mid-video walk yields normal/fast/normal", () => {
  assert.deepEqual(
    buildSegmentPlan([{ startMs: 5000, endMs: 20000, kind: "walk" }], 30000),
    [
      { startMs: 0, endMs: 5000, mode: "normal" },
      { startMs: 5000, endMs: 20000, mode: "fast" },
      { startMs: 20000, endMs: null, mode: "normal" },
    ],
  );
});

test("buildSegmentPlan: walk at t=0 has no leading piece", () => {
  assert.deepEqual(
    buildSegmentPlan([{ startMs: 0, endMs: 4000, kind: "walk" }], 10000),
    [
      { startMs: 0, endMs: 4000, mode: "fast" },
      { startMs: 4000, endMs: null, mode: "normal" },
    ],
  );
});

test("buildSegmentPlan: walk reaching EOF is fast and open-ended", () => {
  assert.deepEqual(
    buildSegmentPlan([{ startMs: 6000, endMs: 10000, kind: "walk" }], 10000),
    [
      { startMs: 0, endMs: 6000, mode: "normal" },
      { startMs: 6000, endMs: null, mode: "fast" },
    ],
  );
});

test("buildSegmentPlan: two walk legs alternate normal and fast", () => {
  assert.deepEqual(
    buildSegmentPlan(
      [
        { startMs: 1000, endMs: 3000, kind: "walk" },
        { startMs: 7000, endMs: 9000, kind: "walk" },
      ],
      10000,
    ),
    [
      { startMs: 0, endMs: 1000, mode: "normal" },
      { startMs: 1000, endMs: 3000, mode: "fast" },
      { startMs: 3000, endMs: 7000, mode: "normal" },
      { startMs: 7000, endMs: 9000, mode: "fast" },
      { startMs: 9000, endMs: null, mode: "normal" },
    ],
  );
});

test("buildSegmentPlan: loading cut is absent; neighbours abut across the hole", () => {
  const plan = buildSegmentPlan(
    [
      { startMs: 1000, endMs: 3000, kind: "walk" },
      { startMs: 3000, endMs: 7000, kind: "loading" },
      { startMs: 7000, endMs: 9000, kind: "walk" },
    ],
    10000,
  );
  assert.deepEqual(plan, [
    { startMs: 0, endMs: 1000, mode: "normal" },
    { startMs: 1000, endMs: 3000, mode: "fast" },
    // 3000–7000 cut: no piece
    { startMs: 7000, endMs: 9000, mode: "fast" },
    { startMs: 9000, endMs: null, mode: "normal" },
  ]);
  assert.ok(plan && plan.every((p) => p.mode !== ("cut" as string)));
  // No piece covers the cut range.
  assert.ok(
    plan &&
      plan.every(
        (p) => (p.endMs !== null && p.endMs <= 3000) || p.startMs >= 7000,
      ),
  );
});

test("buildSegmentPlan: trailing loading stays closed (not open-ended)", () => {
  // Open-ending the preceding piece would re-include the cut region.
  assert.deepEqual(
    buildSegmentPlan([{ startMs: 5000, endMs: 10000, kind: "loading" }], 10000),
    [{ startMs: 0, endMs: 5000, mode: "normal" }],
  );
});

test("buildSegmentPlan: mid-video loading only leaves normal flanks", () => {
  assert.deepEqual(
    buildSegmentPlan([{ startMs: 2000, endMs: 6000, kind: "loading" }], 10000),
    [
      { startMs: 0, endMs: 2000, mode: "normal" },
      { startMs: 6000, endMs: null, mode: "normal" },
    ],
  );
});

test("buildSegmentPlan: nothing to do returns null", () => {
  assert.equal(buildSegmentPlan([], 10000), null);
});

test("parseDurationMs: reads the ffmpeg banner", () => {
  assert.equal(
    parseDurationMs("  Duration: 00:00:30.05, start: 0.000000, bitrate: 1"),
    30050,
  );
  assert.equal(parseDurationMs("Duration: 01:02:03.50"), 3723500);
});

test("parseDurationMs: N/A or garbage is null", () => {
  assert.equal(parseDurationMs("Duration: N/A, bitrate: N/A"), null);
  assert.equal(parseDurationMs(""), null);
});

test("hasAllFilters: full build passes, Playwright's stripped build fails", () => {
  const full = [
    " ... trim              V->V       Pick one continuous section",
    " ... setpts            V->V       Set PTS for the output video frame.",
    " ... concat            N->N       Concatenate audio and video streams.",
    " ... fps               V->V       Force constant framerate.",
  ].join("\n");
  assert.equal(hasAllFilters(full, REQUIRED_FILTERS), true);

  // What the bundled -filters listing actually contains (no setpts/concat/fps).
  const stripped = [
    " ..C scale             V->V       Scale the input video size.",
    " ... trim              V->V       Pick one continuous section",
  ].join("\n");
  assert.equal(hasAllFilters(stripped, REQUIRED_FILTERS), false);
});
