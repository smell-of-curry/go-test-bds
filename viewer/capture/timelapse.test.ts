// Unit tests for the pure timelapse computation (no ffmpeg involved).
// Run with: npm run test:capture (tsx --test, node:test runner).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPieceFfmpegArgs,
  buildSegmentPlan,
  capIntervals,
  computeMarkedIntervals,
  computeSuiteCutIntervals,
  computeWalkIntervals,
  hasAllFilters,
  MIN_CUT_INTERVAL_MS,
  parseDurationMs,
  REQUIRED_FILTERS,
  resolveKeepSuite,
  resolveTimelapsePlan,
  suiteKeepBoundsUnreliable,
} from "./timelapse";

const start = (tMs: number) => ({ message: "walk:start", tMs });
const end = (tMs: number) => ({ message: "walk:end", tMs });
const loadStart = (tMs: number) => ({ message: "loading:start", tMs });
const loadEnd = (tMs: number) => ({ message: "loading:end", tMs });
const idleStart = (tMs: number) => ({ message: "idle:start", tMs });
const idleEnd = (tMs: number) => ({ message: "idle:end", tMs });
const highlightStart = (tMs: number) => ({ message: "highlight:start", tMs });
const highlightEnd = (tMs: number) => ({ message: "highlight:end", tMs });
const suiteStart = (tMs: number, suite: string) => ({
  message: "suite:start",
  tMs,
  suite,
});
const suiteEnd = (tMs: number, suite: string) => ({
  message: "suite:end",
  tMs,
  suite,
});

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
      null,
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
      null,
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
      null,
    ),
    [{ startMs: 2000, endMs: 5000, kind: "loading" }],
  );
});

test("computeMarkedIntervals: unmatched loading:start is dropped (not cut-to-EOF)", () => {
  // Run 45: a lost loading:end near the crate leg erased the finale when
  // unmatched starts closed at durationMs. Dropping them keeps the tail.
  assert.deepEqual(computeMarkedIntervals([loadStart(4000)], 10000, null), []);
  assert.deepEqual(
    computeMarkedIntervals([start(0), loadStart(6000), end(8000)], 10000, null),
    [{ startMs: 0, endMs: 8000, kind: "walk" }],
  );
});

test("computeMarkedIntervals: sub-1s loading interval is kept (not cut)", () => {
  // Below MIN_CUT_INTERVAL_MS → dropped before the overlap pass, so a
  // surrounding walk stays continuous (no hole, no cut piece).
  assert.ok(MIN_CUT_INTERVAL_MS >= 1000);
  assert.deepEqual(
    computeMarkedIntervals(
      [start(0), loadStart(4000), loadEnd(4500), end(10000)],
      10000,
      null,
    ),
    [{ startMs: 0, endMs: 10000, kind: "walk" }],
  );
  assert.deepEqual(
    computeMarkedIntervals([loadStart(4000), loadEnd(4500)], 10000, null),
    [],
  );
});

test("computeMarkedIntervals: idle marks are tagged idle", () => {
  assert.deepEqual(
    computeMarkedIntervals([idleStart(2000), idleEnd(8000)], 10000, null),
    [{ startMs: 2000, endMs: 8000, kind: "idle" }],
  );
});

test("computeMarkedIntervals: walk wins over idle on overlap", () => {
  assert.deepEqual(
    computeMarkedIntervals(
      [idleStart(0), start(3000), end(7000), idleEnd(10000)],
      10000,
      null,
    ),
    [
      { startMs: 0, endMs: 3000, kind: "idle" },
      { startMs: 3000, endMs: 7000, kind: "walk" },
      { startMs: 7000, endMs: 10000, kind: "idle" },
    ],
  );
});

test("computeMarkedIntervals: highlight beats walk beats idle", () => {
  assert.deepEqual(
    computeMarkedIntervals(
      [
        idleStart(0),
        start(2000),
        highlightStart(4000),
        highlightEnd(6000),
        end(8000),
        idleEnd(10000),
      ],
      10000,
      null,
    ),
    [
      { startMs: 0, endMs: 2000, kind: "idle" },
      { startMs: 2000, endMs: 4000, kind: "walk" },
      { startMs: 4000, endMs: 6000, kind: "highlight" },
      { startMs: 6000, endMs: 8000, kind: "walk" },
      { startMs: 8000, endMs: 10000, kind: "idle" },
    ],
  );
});

test("computeMarkedIntervals: loading still beats highlight", () => {
  assert.deepEqual(
    computeMarkedIntervals(
      [highlightStart(0), loadStart(3000), loadEnd(7000), highlightEnd(10000)],
      10000,
      null,
    ),
    [
      { startMs: 0, endMs: 3000, kind: "highlight" },
      { startMs: 3000, endMs: 7000, kind: "loading" },
      { startMs: 7000, endMs: 10000, kind: "highlight" },
    ],
  );
});

test("buildSegmentPlan: highlight pieces play as highlight mode", () => {
  assert.deepEqual(
    buildSegmentPlan(
      [
        { startMs: 1000, endMs: 3000, kind: "walk" },
        { startMs: 5000, endMs: 9000, kind: "highlight" },
      ],
      10000,
    ),
    [
      { startMs: 0, endMs: 1000, mode: "idle" },
      { startMs: 1000, endMs: 3000, mode: "walk" },
      { startMs: 3000, endMs: 5000, mode: "idle" },
      { startMs: 5000, endMs: 9000, mode: "highlight" },
      { startMs: 9000, endMs: null, mode: "idle" },
    ],
  );
});

test("capIntervals: highlight wins over walk when merging", () => {
  const ivs = [
    { startMs: 0, endMs: 1000, kind: "walk" as const },
    { startMs: 1200, endMs: 2000, kind: "highlight" as const },
    { startMs: 9000, endMs: 9500, kind: "walk" as const },
  ];
  assert.deepEqual(capIntervals(ivs, 2), [
    { startMs: 0, endMs: 2000, kind: "highlight" },
    { startMs: 9000, endMs: 9500, kind: "walk" },
  ]);
});

test("computeSuiteCutIntervals: cuts non-showcase and prefix before first keep", () => {
  assert.deepEqual(
    computeSuiteCutIntervals(
      [
        suiteStart(0, "Smoke"),
        suiteEnd(30_000, "Smoke"),
        suiteStart(30_000, "Machines"),
        suiteEnd(90_000, "Machines"),
        suiteStart(90_000, "Tutorial Showcase"),
        suiteEnd(400_000, "Tutorial Showcase"),
      ],
      450_000,
      /showcase/i,
    ),
    [
      // prefix (empty here — Smoke starts at 0) merged with Smoke + Machines
      { startMs: 0, endMs: 90_000 },
    ],
  );
});

test("computeSuiteCutIntervals: does not cut after the last suite (finale tail)", () => {
  const cuts = computeSuiteCutIntervals(
    [
      suiteStart(10_000, "Tutorial Showcase"),
      suiteEnd(200_000, "Tutorial Showcase"),
    ],
    250_000,
    /showcase/i,
  );
  // Prefix before showcase is cut; post-suiteEnd tail is kept.
  assert.deepEqual(cuts, [{ startMs: 0, endMs: 10_000 }]);
});

test("computeMarkedIntervals: suite cuts act as loading", () => {
  const ivs = computeMarkedIntervals(
    [
      suiteStart(0, "Smoke"),
      suiteEnd(50_000, "Smoke"),
      suiteStart(50_000, "Tutorial Showcase"),
      start(60_000),
      end(80_000),
      suiteEnd(100_000, "Tutorial Showcase"),
    ],
    120_000,
    /showcase/i,
  );
  assert.deepEqual(ivs, [
    { startMs: 0, endMs: 50_000, kind: "loading" },
    { startMs: 60_000, endMs: 80_000, kind: "walk" },
  ]);
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

test("capIntervals: does not merge loading into walk (drops short cut)", () => {
  // Mixing loading with walk used to expand the cut over the walk beat.
  const ivs = [
    { startMs: 0, endMs: 1000, kind: "walk" as const },
    { startMs: 1200, endMs: 2000, kind: "loading" as const },
    { startMs: 9000, endMs: 9500, kind: "walk" as const },
  ];
  assert.deepEqual(capIntervals(ivs, 2), [
    { startMs: 0, endMs: 1000, kind: "walk" },
    { startMs: 9000, endMs: 9500, kind: "walk" },
  ]);
});

test("capIntervals: same-kind loading merges before touching walk", () => {
  const ivs = [
    { startMs: 0, endMs: 1000, kind: "loading" as const },
    { startMs: 1100, endMs: 2000, kind: "loading" as const },
    { startMs: 5000, endMs: 8000, kind: "walk" as const },
    { startMs: 9000, endMs: 9500, kind: "highlight" as const },
  ];
  assert.deepEqual(capIntervals(ivs, 3), [
    { startMs: 0, endMs: 2000, kind: "loading" },
    { startMs: 5000, endMs: 8000, kind: "walk" },
    { startMs: 9000, endMs: 9500, kind: "highlight" },
  ]);
});

test("buildSegmentPlan: mid-video walk yields idle/walk/idle", () => {
  assert.deepEqual(
    buildSegmentPlan([{ startMs: 5000, endMs: 20000, kind: "walk" }], 30000),
    [
      { startMs: 0, endMs: 5000, mode: "idle" },
      { startMs: 5000, endMs: 20000, mode: "walk" },
      { startMs: 20000, endMs: null, mode: "idle" },
    ],
  );
});

test("buildSegmentPlan: walk at t=0 has no leading piece", () => {
  assert.deepEqual(
    buildSegmentPlan([{ startMs: 0, endMs: 4000, kind: "walk" }], 10000),
    [
      { startMs: 0, endMs: 4000, mode: "walk" },
      { startMs: 4000, endMs: null, mode: "idle" },
    ],
  );
});

test("buildSegmentPlan: walk reaching EOF is walk and open-ended", () => {
  assert.deepEqual(
    buildSegmentPlan([{ startMs: 6000, endMs: 10000, kind: "walk" }], 10000),
    [
      { startMs: 0, endMs: 6000, mode: "idle" },
      { startMs: 6000, endMs: null, mode: "walk" },
    ],
  );
});

test("buildSegmentPlan: two walk legs alternate idle and walk", () => {
  assert.deepEqual(
    buildSegmentPlan(
      [
        { startMs: 1000, endMs: 3000, kind: "walk" },
        { startMs: 7000, endMs: 9000, kind: "walk" },
      ],
      10000,
    ),
    [
      { startMs: 0, endMs: 1000, mode: "idle" },
      { startMs: 1000, endMs: 3000, mode: "walk" },
      { startMs: 3000, endMs: 7000, mode: "idle" },
      { startMs: 7000, endMs: 9000, mode: "walk" },
      { startMs: 9000, endMs: null, mode: "idle" },
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
    { startMs: 0, endMs: 1000, mode: "idle" },
    { startMs: 1000, endMs: 3000, mode: "walk" },
    // 3000–7000 cut: no piece
    { startMs: 7000, endMs: 9000, mode: "walk" },
    { startMs: 9000, endMs: null, mode: "idle" },
  ]);
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
    [{ startMs: 0, endMs: 5000, mode: "idle" }],
  );
});

test("buildSegmentPlan: mid-video loading only leaves idle flanks", () => {
  assert.deepEqual(
    buildSegmentPlan([{ startMs: 2000, endMs: 6000, kind: "loading" }], 10000),
    [
      { startMs: 0, endMs: 2000, mode: "idle" },
      { startMs: 6000, endMs: null, mode: "idle" },
    ],
  );
});

test("buildSegmentPlan: suite cut of the black open leaves showcase idle/walk", () => {
  // Smoke 0–120s cut; walk inside showcase; idle gaps around the walk.
  const plan = buildSegmentPlan(
    [
      { startMs: 0, endMs: 120_000, kind: "loading" },
      { startMs: 150_000, endMs: 180_000, kind: "walk" },
    ],
    200_000,
  );
  assert.deepEqual(plan, [
    { startMs: 120_000, endMs: 150_000, mode: "idle" },
    { startMs: 150_000, endMs: 180_000, mode: "walk" },
    { startMs: 180_000, endMs: null, mode: "idle" },
  ]);
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
    " ... setpts            V->V       Set PTS for the output video frame.",
    " ... concat            N->N       Concatenate audio and video streams.",
    " ... fps               V->V       Force constant framerate.",
  ].join("\n");
  // REQUIRED_FILTERS is setpts/fps — both present in `full`.
  assert.equal(hasAllFilters(full, REQUIRED_FILTERS), true);

  // What the bundled -filters listing actually contains (no setpts/fps).
  const stripped = [
    " ..C scale             V->V       Scale the input video size.",
    " ... trim              V->V       Pick one continuous section",
  ].join("\n");
  assert.equal(hasAllFilters(stripped, REQUIRED_FILTERS), false);
});

test("buildPieceFfmpegArgs: realtime uses input -t, no trim filter", () => {
  const args = buildPieceFfmpegArgs({
    videoPath: "/tmp/run.webm",
    segPath: "/tmp/seg.webm",
    startMs: 204_600,
    srcMs: 40_600,
    speed: 1,
    openEnded: false,
  });
  assert.deepEqual(args.slice(0, 8), [
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-ss",
    "204.600",
    "-t",
    "40.600",
  ]);
  assert.equal(args[8], "-i");
  assert.equal(args[9], "/tmp/run.webm");
  const vf = args[args.indexOf("-filter:v") + 1];
  assert.equal(vf, "setpts=PTS-STARTPTS,fps=25");
  assert.ok(!vf.includes("trim"));
});

test("buildPieceFfmpegArgs: walk speed-up adds setpts/N", () => {
  const args = buildPieceFfmpegArgs({
    videoPath: "/tmp/run.webm",
    segPath: "/tmp/seg.webm",
    startMs: 0,
    srcMs: 8_000,
    speed: 8,
    openEnded: false,
  });
  const vf = args[args.indexOf("-filter:v") + 1];
  assert.equal(vf, "setpts=PTS-STARTPTS,setpts=PTS/8,fps=25");
});

test("buildPieceFfmpegArgs: open-ended omits -t", () => {
  const args = buildPieceFfmpegArgs({
    videoPath: "/tmp/run.webm",
    segPath: "/tmp/seg.webm",
    startMs: 90_000,
    srcMs: 10_000,
    speed: 24,
    openEnded: true,
  });
  assert.ok(!args.includes("-t"));
  assert.equal(args[args.indexOf("-ss") + 1], "90.000");
});

test("resolveKeepSuite: default / empty / custom", () => {
  assert.equal(resolveKeepSuite(undefined)!.source, "showcase");
  assert.equal(resolveKeepSuite("1")!.source, "showcase");
  assert.equal(resolveKeepSuite(""), null);
  assert.equal(resolveKeepSuite("0"), null);
  assert.equal(
    resolveKeepSuite("Tutorial Showcase")!.test("Tutorial Showcase"),
    true,
  );
});

test("computeSuiteCutIntervals: Tutorial alone is cut; Tutorial Showcase kept", () => {
  // Regression for probe-r2: step Tutorial must not match /showcase/i.
  const keep = /showcase/i;
  assert.equal(keep.test("Tutorial"), false);
  assert.equal(keep.test("Tutorial Showcase"), true);
  assert.deepEqual(
    computeSuiteCutIntervals(
      [
        suiteStart(0, "Smoke"),
        suiteEnd(10_000, "Smoke"),
        suiteStart(10_000, "UI Probe"),
        suiteEnd(20_000, "UI Probe"),
        suiteStart(20_000, "Tutorial"),
        suiteEnd(80_000, "Tutorial"),
        suiteStart(80_000, "Tutorial Showcase"),
        suiteEnd(400_000, "Tutorial Showcase"),
      ],
      420_000,
      keep,
    ),
    [{ startMs: 0, endMs: 80_000 }],
  );
});

test("buildSegmentPlan: cutting pre-showcase removes the void open", () => {
  const intervals = computeMarkedIntervals(
    [
      suiteStart(0, "Smoke"),
      suiteEnd(5_000, "Smoke"),
      suiteStart(5_000, "Tutorial Showcase"),
      start(6_000),
      end(20_000),
      suiteEnd(40_000, "Tutorial Showcase"),
    ],
    45_000,
    /showcase/i,
  );
  const plan = buildSegmentPlan(intervals, 45_000);
  assert.ok(plan);
  assert.ok(plan![0].startMs >= 5_000, "plan must not include Smoke void");
  assert.deepEqual(plan![0], {
    startMs: 5_000,
    endMs: 6_000,
    mode: "idle",
  });
});

test("resolveTimelapsePlan: truncated recording with keep-suite past EOF does not idle whole file", () => {
  const durationMs = 204_000;
  const intervals = computeMarkedIntervals(
    [
      suiteStart(0, "Smoke"),
      suiteEnd(30_000, "Smoke"),
      suiteStart(30_000, "Machines"),
      suiteEnd(200_000, "Machines"),
      suiteStart(210_000, "Tutorial Showcase"),
      suiteEnd(600_000, "Tutorial Showcase"),
    ],
    durationMs,
    /showcase/i,
  );
  assert.ok(
    intervals.some((iv) => iv.kind === "loading" && iv.endMs === durationMs),
  );
  const resolved = resolveTimelapsePlan(intervals, durationMs, 24);
  assert.equal(resolved.entireCut, true);
  assert.equal(resolved.plan, null);
});

test("resolveTimelapsePlan: real truncated pair — Smoke starts after 0, showcase past EOF", () => {
  // Exact shape from run-pr-704-1785539248421: recording 7.04s, Smoke opens
  // at 4325ms (not 0), showcase at 150410ms. Unsorted merge used to keep
  // [0,4325) as idle Smoke and never entireCut.
  const durationMs = 7040;
  const intervals = computeMarkedIntervals(
    [
      suiteStart(4325, "Smoke"),
      suiteEnd(19_026, "Smoke"),
      suiteStart(19_125, "UI Probe"),
      suiteEnd(50_975, "UI Probe"),
      suiteStart(51_515, "Machines"),
      suiteEnd(95_804, "Machines"),
      suiteStart(95_855, "Tutorial"),
      suiteEnd(150_304, "Tutorial"),
      suiteStart(150_410, "Tutorial Showcase"),
      suiteEnd(543_355, "Tutorial Showcase"),
    ],
    durationMs,
    /showcase/i,
  );
  assert.deepEqual(intervals, [
    { startMs: 0, endMs: durationMs, kind: "loading" },
  ]);
  const resolved = resolveTimelapsePlan(intervals, durationMs, 24);
  assert.equal(resolved.entireCut, true);
  assert.equal(resolved.plan, null);
});

test("resolveTimelapsePlan: truncated recording still keeps in-frame showcase", () => {
  const durationMs = 204_000;
  const intervals = computeMarkedIntervals(
    [
      suiteStart(0, "Smoke"),
      suiteEnd(180_000, "Smoke"),
      suiteStart(180_000, "Tutorial Showcase"),
      suiteEnd(600_000, "Tutorial Showcase"),
    ],
    durationMs,
    /showcase/i,
  );
  const resolved = resolveTimelapsePlan(intervals, durationMs, 24);
  assert.equal(resolved.entireCut, false);
  assert.ok(resolved.plan);
  assert.ok(resolved.plan![0].startMs >= 180_000);
});

test("resolveTimelapsePlan: idle whole-file only when there are no cuts", () => {
  const resolved = resolveTimelapsePlan([], 10_000, 24);
  assert.equal(resolved.entireCut, false);
  assert.deepEqual(resolved.plan, [{ startMs: 0, endMs: null, mode: "idle" }]);
});

test("suiteKeepBoundsUnreliable: tiny keep window at EOF with outer marks", () => {
  // run-pr-704-1785551849011 shape: walk/loading across the run, suite
  // bounds stamped only in the last 1.3s.
  const durationMs = 431_700;
  const marks = [
    { message: "loading:start", tMs: 4_287 },
    { message: "walk:start", tMs: 17_602 },
    { message: "walk:end", tMs: 413_602 },
    suiteStart(424_754, "Tutorial Showcase"),
    suiteEnd(426_102, "Tutorial Showcase"),
  ];
  assert.equal(suiteKeepBoundsUnreliable(marks, durationMs, /showcase/i), true);
});

test("suiteKeepBoundsUnreliable: healthy showcase span is trusted", () => {
  const durationMs = 431_700;
  const marks = [
    { message: "walk:start", tMs: 17_602 },
    { message: "walk:end", tMs: 400_000 },
    suiteStart(5_000, "Tutorial Showcase"),
    suiteEnd(420_000, "Tutorial Showcase"),
  ];
  assert.equal(
    suiteKeepBoundsUnreliable(marks, durationMs, /showcase/i),
    false,
  );
});

test("suiteKeepBoundsUnreliable: short suite alone (no outer marks) is fine", () => {
  // A genuinely short keep suite with no other timeline marks should not
  // trip the guard — otherwise we can never cut a brief showcase.
  assert.equal(
    suiteKeepBoundsUnreliable(
      [
        suiteStart(1_000, "Tutorial Showcase"),
        suiteEnd(5_000, "Tutorial Showcase"),
      ],
      10_000,
      /showcase/i,
    ),
    false,
  );
});
