// Timelapse post-processing for the run video. Test suites mark spans on the
// SSE stream (mark phase "segment"):
//   walk:start / walk:end       → play at walk speed-up factor
//   idle:start / idle:end       → play at idle speed-up factor (high)
//   loading:start / loading:end → cut from the output entirely
// The harness also synthesises suite:start / suite:end from suiteStart/suiteEnd
// lifecycle marks so non-showcase suites (Smoke / Machines / Tutorial void)
// can be cut without pixel analysis. Unmarked gaps inside kept ranges play at
// the idle factor — waiting between legs should not dominate the reel.
//
// After the recording is finalised those intervals are re-timed with ffmpeg.
// Pure interval/filter computation lives in exported functions so it can be
// unit-tested without ffmpeg.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A segment mark as recorded by the harness, timed against the video timeline. */
export interface WalkMark {
  /**
   * Mark message: walk/idle/loading start|end, or suite:start / suite:end
   * synthesised from lifecycle marks.
   */
  message: string;
  /** Milliseconds since video t=0 (the harness's page-open anchor). */
  tMs: number;
  /** Suite name for suite:start / suite:end marks. */
  suite?: string;
}

/** Kind of a tagged timeline interval. */
export type IntervalKind = "walk" | "loading" | "idle";

/** A half-open time range of the video. */
export interface Interval {
  startMs: number;
  endMs: number;
}

/** A half-open time range tagged as walk / idle (speed up) or loading (cut). */
export interface TaggedInterval extends Interval {
  kind: IntervalKind;
}

/**
 * Hard cap on walk+loading+idle intervals. Each interval costs a couple of
 * per-piece encodes; 32 keeps the ffmpeg argument far below the ~32k Windows
 * command-line limit while covering any sane run.
 */
export const MAX_FAST_INTERVALS = 32;

/**
 * Walk/idle intervals shorter than this are dropped: at high speed-up they
 * save under a quarter second of playback but cost an encode piece.
 */
export const MIN_INTERVAL_MS = 250;

/**
 * Loading / suite-cut intervals shorter than this are kept (played, not cut).
 * Cutting a sub-second blip causes a jarring pop for almost no time saved.
 */
export const MIN_CUT_INTERVAL_MS = 1000;

/** Default speed-up for unmarked gaps and idle:start/end spans. */
export const DEFAULT_IDLE_FACTOR = 24;

/**
 * Suites whose names match are kept in the timelapse. Everything else with a
 * suite:start/suite:end bracket is cut (Smoke / Machines / step Tutorial void).
 * Override with {@link ApplyTimelapseOptions.keepSuite} or env
 * `GOTESTBDS_TIMELAPSE_KEEP_SUITES` (JS RegExp source).
 */
export const DEFAULT_KEEP_SUITE = /showcase/i;

const SEGMENT_MESSAGES = new Set([
  "walk:start",
  "walk:end",
  "idle:start",
  "idle:end",
  "loading:start",
  "loading:end",
  "suite:start",
  "suite:end",
]);

/** Options for pairing start/end marks into intervals. */
interface PairOptions {
  /**
   * When true (default), an unmatched start closes at `durationMs`.
   * When false, unmatched starts are dropped — critical for loading marks:
   * a lost `loading:end` used to cut the entire remainder of the video
   * (run 45 lost the crate finale this way).
   */
  closeOpen?: boolean;
}

/**
 * Pair start/end marks of one kind into raw (unclamped) intervals using a
 * depth counter. Nested/overlapping opens merge; stray ends are ignored.
 *
 * @param marks Marks sorted by time.
 * @param startMsg Message that opens an interval.
 * @param endMsg Message that closes an interval.
 * @param durationMs Close-at for an unmatched start when `closeOpen` is true.
 * @param opts Pairing options.
 * @returns raw intervals (may be empty, unsorted beyond mark order).
 */
function pairMarkIntervals(
  marks: WalkMark[],
  startMsg: string,
  endMsg: string,
  durationMs: number,
  opts: PairOptions = {},
): Interval[] {
  const closeOpen = opts.closeOpen !== false;
  const intervals: Interval[] = [];
  let depth = 0;
  let openedAt = 0;
  for (const m of marks) {
    if (m.message === startMsg) {
      if (depth === 0) openedAt = m.tMs;
      depth++;
    } else if (m.message === endMsg) {
      if (depth === 0) continue; // stray end: nothing to close
      depth--;
      if (depth === 0) intervals.push({ startMs: openedAt, endMs: m.tMs });
    }
  }
  if (closeOpen && depth > 0)
    intervals.push({ startMs: openedAt, endMs: durationMs });
  return intervals;
}

/**
 * Clamp intervals to the video, drop those shorter than `minMs`, and merge
 * neighbours that touch or overlap.
 *
 * @param intervals Raw intervals.
 * @param durationMs Total video duration.
 * @param minMs Minimum kept length.
 * @returns disjoint intervals sorted by start time.
 */
function clampMergeIntervals(
  intervals: Interval[],
  durationMs: number,
  minMs: number,
): Interval[] {
  const clamped = intervals
    .map((iv) => ({
      startMs: Math.max(0, iv.startMs),
      endMs: Math.min(durationMs, iv.endMs),
    }))
    .filter((iv) => iv.endMs - iv.startMs >= minMs)
    // Sort before merge: suite cuts push non-keep spans first, then the
    // `[0, firstKeepStart)` prefix. After clamping a truncated recording,
    // that prefix is `[0, duration]` while Smoke is `[smokeStart, duration]`.
    // Merging unsorted left startMs at smokeStart and shipped a Smoke idle
    // head (run-pr-704-1785539248421: 4.3s Smoke kept, entireCut never fired).
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged: Interval[] = [];
  for (const iv of clamped) {
    const last = merged[merged.length - 1];
    if (last && iv.startMs <= last.endMs)
      last.endMs = Math.max(last.endMs, iv.endMs);
    else merged.push({ ...iv });
  }
  return merged;
}

/**
 * Build cut intervals for suites that do not match `keepSuite`.
 *
 * Also cuts `[0, firstKeptSuiteStart)` so harness/smoke startup void never
 * opens the reel. Does **not** cut after the last suite — celebration frames
 * often land between the last assertion and `runEnd`.
 *
 * @param marks Marks sorted by time (suite:start / suite:end carry `.suite`).
 * @param durationMs Total video duration.
 * @param keepSuite Suites to keep (matched against the suite name).
 * @returns cut intervals (loading-equivalent).
 */
export function computeSuiteCutIntervals(
  marks: WalkMark[],
  durationMs: number,
  keepSuite: RegExp,
): Interval[] {
  const suiteMarks = marks.filter(
    (m) =>
      (m.message === "suite:start" || m.message === "suite:end") &&
      typeof m.suite === "string" &&
      m.suite.length > 0,
  );
  if (suiteMarks.length === 0) return [];

  type Open = { suite: string; tMs: number };
  let open: Open | null = null;
  const spans: Array<{ suite: string; startMs: number; endMs: number }> = [];

  const closeOpen = (endMs: number) => {
    if (!open) return;
    if (endMs > open.tMs)
      spans.push({ suite: open.suite, startMs: open.tMs, endMs });
    open = null;
  };

  for (const m of suiteMarks) {
    if (m.message === "suite:start") {
      closeOpen(m.tMs);
      open = { suite: m.suite!, tMs: m.tMs };
    } else if (m.message === "suite:end") {
      if (open && (m.suite === open.suite || !m.suite)) closeOpen(m.tMs);
      else if (open) closeOpen(m.tMs); // mismatched end still closes
    }
  }
  closeOpen(durationMs);

  const cuts: Interval[] = [];
  let firstKeepStart: number | null = null;
  for (const span of spans) {
    if (keepSuite.test(span.suite)) {
      if (firstKeepStart === null) firstKeepStart = span.startMs;
      continue;
    }
    cuts.push({ startMs: span.startMs, endMs: span.endMs });
  }
  if (firstKeepStart !== null && firstKeepStart > 0)
    cuts.push({ startMs: 0, endMs: firstKeepStart });

  return clampMergeIntervals(cuts, durationMs, MIN_CUT_INTERVAL_MS);
}

/**
 * Collapse walk + loading + idle + suite-cut marks into disjoint, clamped,
 * tagged intervals.
 *
 * Priority on overlap: loading/suite-cut > walk > idle. Sub-minimum walks and
 * idles and sub-{@link MIN_CUT_INTERVAL_MS} loadings are dropped before the
 * overlap pass. Unmatched `loading:start` is **dropped** (not closed at EOF) so
 * a lost `loading:end` cannot erase the finale.
 *
 * @param marks Segment marks in any order (sorted internally by time).
 * @param durationMs Total video duration; intervals are clamped to it.
 * @param keepSuite Suites to keep; `null` disables suite cutting. Default
 * {@link DEFAULT_KEEP_SUITE}.
 * @returns disjoint tagged intervals sorted by start time.
 */
export function computeMarkedIntervals(
  marks: WalkMark[],
  durationMs: number,
  keepSuite: RegExp | null = DEFAULT_KEEP_SUITE,
): TaggedInterval[] {
  const sorted = [...marks].sort((a, b) => a.tMs - b.tMs);
  const walk = clampMergeIntervals(
    pairMarkIntervals(sorted, "walk:start", "walk:end", durationMs),
    durationMs,
    MIN_INTERVAL_MS,
  );
  const idle = clampMergeIntervals(
    pairMarkIntervals(sorted, "idle:start", "idle:end", durationMs),
    durationMs,
    MIN_INTERVAL_MS,
  );
  // closeOpen: false — unmatched loading:start must not cut to EOF.
  const loading = clampMergeIntervals(
    [
      ...pairMarkIntervals(sorted, "loading:start", "loading:end", durationMs, {
        closeOpen: false,
      }),
      ...(keepSuite
        ? computeSuiteCutIntervals(sorted, durationMs, keepSuite)
        : []),
    ],
    durationMs,
    MIN_CUT_INTERVAL_MS,
  );

  // Sweep: loading > walk > idle → disjoint tagged intervals.
  type Edge = { t: number; dWalk: number; dLoad: number; dIdle: number };
  const edges: Edge[] = [];
  for (const iv of walk) {
    edges.push({ t: iv.startMs, dWalk: 1, dLoad: 0, dIdle: 0 });
    edges.push({ t: iv.endMs, dWalk: -1, dLoad: 0, dIdle: 0 });
  }
  for (const iv of idle) {
    edges.push({ t: iv.startMs, dWalk: 0, dLoad: 0, dIdle: 1 });
    edges.push({ t: iv.endMs, dWalk: 0, dLoad: 0, dIdle: -1 });
  }
  for (const iv of loading) {
    edges.push({ t: iv.startMs, dWalk: 0, dLoad: 1, dIdle: 0 });
    edges.push({ t: iv.endMs, dWalk: 0, dLoad: -1, dIdle: 0 });
  }
  edges.sort((a, b) => a.t - b.t);

  const out: TaggedInterval[] = [];
  let walkDepth = 0;
  let loadDepth = 0;
  let idleDepth = 0;
  let segStart = 0;
  let segKind: IntervalKind | null = null;

  const activeKind = (): IntervalKind | null => {
    if (loadDepth > 0) return "loading";
    if (walkDepth > 0) return "walk";
    if (idleDepth > 0) return "idle";
    return null;
  };

  let i = 0;
  while (i < edges.length) {
    const t = edges[i].t;
    while (i < edges.length && edges[i].t === t) {
      walkDepth += edges[i].dWalk;
      loadDepth += edges[i].dLoad;
      idleDepth += edges[i].dIdle;
      i++;
    }
    const next = activeKind();
    if (next === segKind) continue;
    if (segKind !== null && t > segStart)
      out.push({ startMs: segStart, endMs: t, kind: segKind });
    segStart = t;
    segKind = next;
  }
  return out;
}

/**
 * Collapse walk marks into disjoint, clamped walking intervals.
 *
 * Backward-compatible wrapper over {@link computeMarkedIntervals}: loading
 * marks, when present, still win overlaps and punch holes in the walk.
 *
 * @param marks Walk/loading marks in any order (sorted internally by time).
 * @param durationMs Total video duration; intervals are clamped to it.
 * @returns disjoint walk intervals sorted by start time, each at least
 * {@link MIN_INTERVAL_MS} long.
 */
export function computeWalkIntervals(
  marks: WalkMark[],
  durationMs: number,
): Interval[] {
  // Preserve legacy behaviour for callers that only care about walks: do not
  // apply the showcase suite filter (no suite marks in unit tests anyway).
  return computeMarkedIntervals(marks, durationMs, null)
    .filter((iv) => iv.kind === "walk")
    .map(({ startMs, endMs }) => ({ startMs, endMs }));
}

/**
 * Reduce the interval count to `cap` by merging the pair with the smallest
 * gap, repeatedly. The swallowed gap takes the winning kind (loading over
 * walk over idle) — a graceful degradation when a run somehow produces an
 * absurd number of marked legs.
 *
 * @param intervals Disjoint intervals sorted by start time.
 * @param cap Maximum number of intervals to keep.
 * @returns at most `cap` disjoint intervals.
 */
export function capIntervals<T extends Interval>(
  intervals: T[],
  cap: number,
): T[] {
  const out = intervals.map((iv) => ({ ...iv }));
  // ponytail: O(n^2) nearest-gap merge; n is tiny (marks are per walking leg).
  while (out.length > cap) {
    let best = 1;
    let gap = Infinity;
    for (let i = 1; i < out.length; i++) {
      const g = out[i].startMs - out[i - 1].endMs;
      if (g < gap) {
        gap = g;
        best = i;
      }
    }
    const left = out[best - 1];
    const right = out[best];
    left.endMs = right.endMs;
    if (isTagged(left) && isTagged(right))
      left.kind = winningKind(left.kind, right.kind);
    out.splice(best, 1);
  }
  return out;
}

/**
 * @param a Interval kind.
 * @param b Interval kind.
 * @returns the higher-priority kind (loading > walk > idle).
 */
function winningKind(a: IntervalKind, b: IntervalKind): IntervalKind {
  const rank = (k: IntervalKind) =>
    k === "loading" ? 2 : k === "walk" ? 1 : 0;
  return rank(b) > rank(a) ? b : a;
}

/**
 * @param iv Interval that may carry a kind tag.
 * @returns true when `iv` is a {@link TaggedInterval}.
 */
function isTagged(iv: Interval): iv is TaggedInterval {
  return (
    (iv as TaggedInterval).kind === "walk" ||
    (iv as TaggedInterval).kind === "loading" ||
    (iv as TaggedInterval).kind === "idle"
  );
}

/** Playback mode for one contiguous source slice. */
export type PlanMode = "walk" | "idle";

/** One contiguous slice of the source video in the segment plan. */
export interface PlanPiece {
  /** Slice start on the source timeline. */
  startMs: number;
  /** Slice end, or null for "to the end of the file" (the tail piece). */
  endMs: number | null;
  /**
   * How this slice is handled. Loading / suite-cut ranges are never returned
   * by {@link buildSegmentPlan} — they simply omit that range so nothing is
   * encoded for it and nothing lands in the concat list.
   */
  mode: PlanMode;
}

/**
 * Turn tagged intervals into a slice plan covering the keep-able parts of
 * the video. Walk slices play at the walk factor; idle-marked slices and
 * unmarked gaps play at the idle factor; loading / suite-cut slices are
 * omitted. Each kept piece is later encoded by its own ffmpeg invocation and
 * the results are concatenated.
 *
 * A single filter_complex (split/trim/concat) did this in one pass until run
 * 37: ffmpeg feeds every split branch as the input decodes, and frames for
 * concat inputs whose turn has not come yet queue in RAM — for a 24-minute
 * recording that buffered ~28 GB of decoded frames and the kernel OOM-killed
 * ffmpeg (taking the whole manager service down with it, since it shares the
 * cgroup). Per-piece invocations decode only their slice and stream it out,
 * so memory stays flat no matter how long the run is.
 *
 * The final piece is left open-ended when it reaches the video end so a
 * duration probe that slightly undershoots the real length never clips the
 * tail. A trailing cut leaves the preceding piece closed (open-ending it
 * would re-include the cut region).
 *
 * @param intervals Disjoint tagged intervals sorted by start time.
 * @param durationMs Total video duration used to place the tail piece.
 * @returns kept pieces covering the non-cut ranges, or null when there is
 * nothing to rewrite.
 */
/**
 * Resolve encode plan; entireCut when suite cuts removed everything (do not
 * idle-fallback the whole file — that re-ships Smoke on truncated recordings).
 *
 * @param intervals Disjoint tagged intervals.
 * @param durationMs Source video duration.
 * @param idleFactor Idle speed-up (`<= 1` disables whole-file idle).
 * @returns plan and whether the source was entirely cut.
 */
export function resolveTimelapsePlan(
  intervals: readonly TaggedInterval[],
  durationMs: number,
  idleFactor: number,
): { plan: PlanPiece[] | null; entireCut: boolean } {
  const hasCuts = intervals.some((iv) => iv.kind === "loading");
  let plan = buildSegmentPlan(intervals, durationMs);
  if (!plan && idleFactor > 1 && !hasCuts)
    plan = [{ startMs: 0, endMs: null, mode: "idle" }];
  if (!plan && hasCuts) return { plan: null, entireCut: true };
  return { plan, entireCut: false };
}

export function buildSegmentPlan(
  intervals: readonly TaggedInterval[],
  durationMs: number,
): PlanPiece[] | null {
  if (intervals.length === 0) return null;
  const pieces: PlanPiece[] = [];
  let cursor = 0;
  for (const iv of intervals) {
    if (iv.startMs > cursor)
      pieces.push({ startMs: cursor, endMs: iv.startMs, mode: "idle" });
    if (iv.kind === "walk")
      pieces.push({ startMs: iv.startMs, endMs: iv.endMs, mode: "walk" });
    else if (iv.kind === "idle")
      pieces.push({ startMs: iv.startMs, endMs: iv.endMs, mode: "idle" });
    // loading → cut: advance cursor, emit nothing
    cursor = iv.endMs;
  }
  if (cursor < durationMs)
    pieces.push({ startMs: cursor, endMs: null, mode: "idle" });
  if (pieces.length === 0) return null;

  // Open-end only when the last kept piece itself reaches EOF. A trailing
  // cut leaves cursor === durationMs with a last piece ending earlier —
  // that piece must stay closed or the cut content is re-included.
  const last = pieces[pieces.length - 1];
  if (last.endMs === durationMs) last.endMs = null;
  return pieces;
}

/**
 * Parse a duration out of ffmpeg's `-i` banner.
 *
 * @param text ffmpeg stderr text containing `Duration: HH:MM:SS.cc`.
 * @returns the duration in milliseconds, or null when absent/`N/A`.
 */
export function parseDurationMs(text: string): number | null {
  const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Math.round(
    (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000,
  );
}

/**
 * Filters the segment encodes need. Playwright's bundled ffmpeg is built
 * with `--disable-everything` and ships only pad/crop/scale — it cannot
 * re-time video, so every candidate is probed before use. (The concat
 * demuxer is not a filter and cannot be probed here; if a candidate lacks
 * it the join step fails and the raw video is kept.)
 */
export const REQUIRED_FILTERS = ["setpts", "fps"] as const;

/**
 * @param filtersText Output of `ffmpeg -filters`.
 * @param names Filter names that must all be present.
 * @returns true when every named filter appears in the listing.
 */
export function hasAllFilters(
  filtersText: string,
  names: readonly string[],
): boolean {
  return names.every((n) => new RegExp(`\\s${n}\\s`).test(filtersText));
}

/**
 * Find an ffmpeg binary able to run the timelapse graph: `FFMPEG` env
 * override first (matching `tools/montage.mjs`), then `ffmpeg` on PATH, then
 * Playwright's bundled build in the ms-playwright browser cache
 * (`ffmpeg-<rev>/ffmpeg-win64.exe` etc. — present wherever the harness's
 * Chromium came from a Playwright install). Every candidate is capability-
 * probed; one that runs but lacks {@link REQUIRED_FILTERS} is reported and
 * skipped.
 *
 * @param log Optional logger for reporting incapable candidates.
 * @returns an invocable ffmpeg path/command, or null when none is capable.
 */
export function resolveFfmpeg(log?: { warn(m: string): void }): string | null {
  const candidates = [process.env.FFMPEG, "ffmpeg", playwrightFfmpeg()].filter(
    (c): c is string => !!c,
  );

  for (const cand of candidates) {
    const filters = ffmpegFilters(cand);
    if (filters === null) continue; // not runnable
    if (hasAllFilters(filters, REQUIRED_FILTERS)) return cand;
    log?.warn(
      `timelapse: ${cand} lacks the ${REQUIRED_FILTERS.join("/")} filters ` +
        `(Playwright's bundled ffmpeg is filter-stripped); trying the next candidate`,
    );
  }
  return null;
}

/**
 * @param cmd Candidate ffmpeg command or path.
 * @returns the `-filters` listing, or null when the binary cannot be run.
 */
function ffmpegFilters(cmd: string): string | null {
  try {
    return String(
      execFileSync(cmd, ["-hide_banner", "-filters"], { stdio: "pipe" }),
    );
  } catch {
    return null;
  }
}

/**
 * Locate Playwright's bundled ffmpeg in the browser cache.
 *
 * @returns the newest bundled ffmpeg executable, or null.
 */
function playwrightFfmpeg(): string | null {
  // ponytail: PLAYWRIGHT_BROWSERS_PATH=0 (browsers inside node_modules) is not
  // handled; set FFMPEG explicitly in that layout.
  const roots: Array<string | undefined> = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
  ];
  if (process.platform === "win32")
    roots.push(
      join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "ms-playwright",
      ),
    );
  else if (process.platform === "darwin")
    roots.push(join(homedir(), "Library", "Caches", "ms-playwright"));
  else roots.push(join(homedir(), ".cache", "ms-playwright"));

  for (const root of roots) {
    if (!root || root === "0" || !existsSync(root)) continue;
    const dirs = readdirSync(root)
      .filter((d) => d.startsWith("ffmpeg"))
      .sort()
      .reverse(); // newest revision first
    for (const d of dirs) {
      const inner = readdirSync(join(root, d)).find((f) =>
        f.startsWith("ffmpeg"),
      );
      if (inner) return join(root, d, inner);
    }
  }
  return null;
}

/** Outcome of {@link applyTimelapse}, for logging and tests. */
export interface TimelapseResult {
  applied: boolean;
  reason?: string;
  /** Number of encoded plan pieces when applied. */
  pieces?: number;
  inputDurationMs?: number;
  outputDurationMs?: number;
}

/** Options for {@link applyTimelapse}. */
export interface ApplyTimelapseOptions {
  /** The finalised run video (e.g. `run.webm`). */
  videoPath: string;
  /** Segment marks timed against the video timeline. */
  marks: WalkMark[];
  /** Speed-up factor for walk intervals; values <= 1 skip walk speed-up. */
  factor: number;
  /**
   * Speed-up factor for idle gaps and idle:start/end spans. Values <= 1 play
   * those ranges real-time. Default {@link DEFAULT_IDLE_FACTOR}.
   */
  idleFactor?: number;
  /**
   * Suites to keep in the output. `null` disables suite cutting. Default
   * {@link DEFAULT_KEEP_SUITE}.
   */
  keepSuite?: RegExp | null;
  /** Keep the real-time original as `<name>-full.<ext>`. */
  keepRaw: boolean;
  /** Harness logger (info/warn). */
  log: { info(m: string): void; warn(m: string): void };
}

/**
 * Re-encode `videoPath` in place so walking intervals play at `factor`x,
 * idle gaps / idle marks play at `idleFactor`x, loading intervals and
 * non-kept suites are removed.
 *
 * Never loses the video: any missing prerequisite (marks, ffmpeg, duration)
 * leaves the original untouched with a log line, and an ffmpeg failure
 * restores the original file. The untouched original survives as
 * `<name>-full.<ext>` beside the output when `keepRaw` is set.
 *
 * Loading / suite cuts apply even when `factor <= 1`. Walk speed-up requires
 * `factor > 1`; idle speed-up requires `idleFactor > 1`.
 *
 * @param opts Timelapse inputs and policy knobs.
 * @returns what happened, including piece counts when applied.
 */
export function applyTimelapse(opts: ApplyTimelapseOptions): TimelapseResult {
  const {
    videoPath,
    marks,
    factor,
    keepRaw,
    log,
    idleFactor = DEFAULT_IDLE_FACTOR,
    keepSuite = DEFAULT_KEEP_SUITE,
  } = opts;

  const segmentMarks = marks.filter((m) => SEGMENT_MESSAGES.has(m.message));
  if (segmentMarks.length === 0) {
    log.info("timelapse: no segment marks; leaving the video as-is");
    return { applied: false, reason: "no marks" };
  }

  const ff = resolveFfmpeg(log);
  if (!ff) {
    log.warn(
      "timelapse: no capable ffmpeg (checked FFMPEG env, PATH, Playwright cache); " +
        "install a full ffmpeg or set FFMPEG; leaving the video as-is",
    );
    return { applied: false, reason: "no ffmpeg" };
  }

  const durationMs = probeDurationMs(ff, videoPath);
  if (!durationMs) {
    log.warn(
      `timelapse: could not read duration of ${videoPath}; leaving the video as-is`,
    );
    return { applied: false, reason: "no duration" };
  }

  const suiteMarkCount = segmentMarks.filter(
    (m) => m.message === "suite:start" || m.message === "suite:end",
  ).length;
  const maxMarkMs = segmentMarks.reduce((m, x) => Math.max(m, x.tMs), 0);
  if (maxMarkMs > durationMs + 5_000) {
    log.warn(
      `timelapse: RECORDING SHORTER THAN RUN — video=${(durationMs / 1000).toFixed(1)}s ` +
        `but marks span to ${(maxMarkMs / 1000).toFixed(1)}s ` +
        `(capture likely stalled mid-run; suite cuts still applied to what exists)`,
    );
  }
  log.info(
    `timelapse: marks=${segmentMarks.length} suiteBounds=${suiteMarkCount} ` +
      `keepSuite=${keepSuite ? keepSuite.source : "off"} ` +
      `walkFactor=${factor} idleFactor=${idleFactor}`,
  );

  let intervals = computeMarkedIntervals(segmentMarks, durationMs, keepSuite);
  if (factor <= 1) intervals = intervals.filter((iv) => iv.kind !== "walk");
  if (idleFactor <= 1) intervals = intervals.filter((iv) => iv.kind !== "idle");
  intervals = capIntervals(intervals, MAX_FAST_INTERVALS);

  const hasCuts = intervals.some((iv) => iv.kind === "loading");
  const hasWalkSpeed = factor > 1 && intervals.some((iv) => iv.kind === "walk");
  if (!hasCuts && !hasWalkSpeed && idleFactor <= 1) {
    log.info("timelapse: no usable intervals; leaving the video as-is");
    return { applied: false, reason: "no intervals" };
  }

  const resolved = resolveTimelapsePlan(intervals, durationMs, idleFactor);
  if (resolved.entireCut) {
    log.warn(
      "timelapse: keep-suite footage absent from (truncated?) recording; " +
        "refusing to ship cut suites — writing a minimal black placeholder",
    );
    const placeholderOk = writeBlackPlaceholder(ff, videoPath, keepRaw, log);
    return placeholderOk
      ? {
          applied: true,
          pieces: 0,
          inputDurationMs: durationMs,
          outputDurationMs: placeholderOk,
        }
      : { applied: false, reason: "entire cut; placeholder failed" };
  }
  if (!resolved.plan) {
    log.info("timelapse: no usable intervals; leaving the video as-is");
    return { applied: false, reason: "no intervals" };
  }
  const effectivePlan = resolved.plan;

  const walkIvs = intervals.filter((iv) => iv.kind === "walk");
  const idleIvs = intervals.filter((iv) => iv.kind === "idle");
  const loadingIvs = intervals.filter((iv) => iv.kind === "loading");
  const cutMs = loadingIvs.reduce(
    (sum, iv) => sum + (iv.endMs - iv.startMs),
    0,
  );

  // Each piece is encoded by its own streaming ffmpeg invocation (see
  // buildSegmentPlan for why one filter_complex pass is banned: it OOM-killed
  // the box on long runs), then joined losslessly with the concat demuxer.
  // The final rename swaps in the result only on success, so a crash or
  // SIGKILL mid-encode (run 35) still leaves a playable run video.
  const rawPath = rawSiblingPath(videoPath);
  const tmpPath = `${videoPath}.tmp.webm`;
  const segDir = `${videoPath}.tlseg`;
  const sec = (ms: number) => (ms / 1000).toFixed(3);
  try {
    mkdirSync(segDir, { recursive: true });
    const segPaths: string[] = [];
    effectivePlan.forEach((p, i) => {
      const segPath = join(segDir, `seg_${String(i).padStart(3, "0")}.webm`);
      segPaths.push(segPath);
      // -ss before -i seeks the input; with -t (a duration, unambiguous
      // regardless of -ss placement) the invocation decodes only its slice.
      const args = ["-nostdin", "-y", "-loglevel", "error"];
      args.push("-ss", sec(p.startMs));
      if (p.endMs !== null) args.push("-t", sec(p.endMs - p.startMs));
      args.push("-i", videoPath);
      const speed =
        p.mode === "walk" && factor > 1
          ? factor
          : p.mode === "idle" && idleFactor > 1
            ? idleFactor
            : 1;
      const pts =
        speed > 1 ? `setpts=(PTS-STARTPTS)/${speed}` : "setpts=PTS-STARTPTS";
      // fps=25 (Playwright's recording rate) drops the surplus frames a fast
      // piece would otherwise carry into the output.
      args.push("-filter:v", `${pts},fps=25`, "-an");
      // Mirrors Playwright's own vp8 recording settings so quality/size match
      // the recording; realtime deadline keeps the pass well under the
      // recording's own length.
      args.push("-c:v", "libvpx", "-qmin", "0", "-qmax", "50");
      args.push("-crf", "8", "-b:v", "1M");
      args.push("-deadline", "realtime", "-cpu-used", "8", segPath);
      execFileSync(ff, args, { stdio: ["ignore", "ignore", "pipe"] });
    });

    // concat demuxer + stream copy: every segment shares codec/params, so the
    // join is a cheap remux. Quoted-and-escaped paths per the demuxer's rules.
    const listPath = join(segDir, "list.txt");
    writeFileSync(
      listPath,
      segPaths.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n"),
    );
    execFileSync(
      ff,
      [
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        tmpPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (err) {
    try {
      unlinkSync(tmpPath); // partial output, if any
    } catch {
      /* ignore */
    }
    log.warn(
      `timelapse: ffmpeg failed; keeping the real-time video (${String(err).split("\n")[0]})`,
    );
    return { applied: false, reason: "ffmpeg failed" };
  } finally {
    rmSync(segDir, { recursive: true, force: true });
  }

  if (keepRaw) renameSync(videoPath, rawPath);
  renameSync(tmpPath, videoPath);
  const outputDurationMs = probeDurationMs(ff, videoPath);
  const walkPart =
    walkIvs.length > 0
      ? `x${factor} over ${walkIvs.length} walk interval(s), `
      : "";
  const idlePart =
    idleFactor > 1
      ? `x${idleFactor} idle gaps` +
        (idleIvs.length > 0 ? `+${idleIvs.length} idle mark(s)` : "") +
        ", "
      : "";
  const cutPart =
    loadingIvs.length > 0
      ? `cut ${loadingIvs.length} loading/suite interval(s), ${(cutMs / 1000).toFixed(1)}s; `
      : "";
  log.info(
    `timelapse: ${walkPart}${idlePart}${cutPart}` +
      `${effectivePlan.length} piece(s); ${(durationMs / 1000).toFixed(1)}s -> ` +
      `${outputDurationMs ? (outputDurationMs / 1000).toFixed(1) : "?"}s` +
      (keepRaw ? `; raw kept at ${rawPath}` : ""),
  );
  return {
    applied: true,
    pieces: effectivePlan.length,
    inputDurationMs: durationMs,
    ...(outputDurationMs ? { outputDurationMs } : {}),
  };
}

/**
 * Replace videoPath with a short black webm so a full suite-cut never ships Smoke.
 *
 * @param ff ffmpeg binary.
 * @param videoPath Output path to overwrite.
 * @param keepRaw Keep the pre-cut source as -full.
 * @param log Logger.
 * @returns placeholder duration ms, or null on failure.
 */
function writeBlackPlaceholder(
  ff: string,
  videoPath: string,
  keepRaw: boolean,
  log: { info(m: string): void; warn(m: string): void },
): number | null {
  const rawPath = rawSiblingPath(videoPath);
  const tmpPath = `${videoPath}.tmp.webm`;
  try {
    execFileSync(
      ff,
      [
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=1280x720:d=0.04",
        "-c:v",
        "libvpx",
        "-crf",
        "8",
        "-b:v",
        "1M",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-an",
        tmpPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    if (keepRaw) renameSync(videoPath, rawPath);
    else {
      try {
        unlinkSync(videoPath);
      } catch {
        /* ignore */
      }
    }
    renameSync(tmpPath, videoPath);
    const outMs = probeDurationMs(ff, videoPath) ?? 40;
    log.info(
      `timelapse: wrote black placeholder ${(outMs / 1000).toFixed(2)}s` +
        (keepRaw ? `; raw kept at ${rawPath}` : ""),
    );
    return outMs;
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    log.warn(
      `timelapse: black placeholder failed (${String(err).split("\n")[0]})`,
    );
    return null;
  }
}

/**
 * @param videoPath The final video path (e.g. `…/run.webm`).
 * @returns the sibling path for the untouched original (`…/run-full.webm`).
 */
function rawSiblingPath(videoPath: string): string {
  const dir = dirname(videoPath);
  const base = videoPath.slice(dir.length + 1);
  const dot = base.lastIndexOf(".");
  const raw =
    dot > 0 ? `${base.slice(0, dot)}-full${base.slice(dot)}` : `${base}-full`;
  return join(dir, raw);
}

/**
 * Read a media file's duration via `ffmpeg -i` (the bundled Playwright build
 * has no ffprobe; parsing the banner is the `tools/montage.mjs` precedent).
 *
 * @param ff ffmpeg command or path.
 * @param path Media file to probe.
 * @returns duration in milliseconds, or null when unreadable.
 */
function probeDurationMs(ff: string, path: string): number | null {
  try {
    // No output file: ffmpeg exits non-zero after printing the banner.
    execFileSync(ff, ["-hide_banner", "-i", path], { stdio: "pipe" });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    if (stderr) return parseDurationMs(String(stderr));
  }
  return null;
}

/**
 * Resolve the keep-suite RegExp from an env string or the default.
 *
 * @param envValue Raw `GOTESTBDS_TIMELAPSE_KEEP_SUITES` value.
 * @returns a RegExp, or `null` when suite cutting is disabled (`""` / `"0"`).
 */
export function resolveKeepSuite(
  envValue: string | undefined = process.env.GOTESTBDS_TIMELAPSE_KEEP_SUITES,
): RegExp | null {
  if (envValue === "" || envValue === "0") return null;
  if (envValue === undefined || envValue === "1") return DEFAULT_KEEP_SUITE;
  try {
    return new RegExp(envValue, "i");
  } catch {
    return DEFAULT_KEEP_SUITE;
  }
}
