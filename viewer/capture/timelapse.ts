// Timelapse post-processing for the run video. Test suites mark walking legs
// on the SSE stream (mark phase "segment", message "walk:start"/"walk:end");
// after the recording is finalised the walking intervals are re-timed with
// ffmpeg so an 8x walk does not dominate a recording while everything else
// stays real-time. Pure interval/filter computation lives in exported
// functions so it can be unit-tested without ffmpeg.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A walk mark as recorded by the harness, timed against the video timeline. */
export interface WalkMark {
  /** Mark message: "walk:start" or "walk:end". */
  message: string;
  /** Milliseconds since video t=0 (the harness's page-open anchor). */
  tMs: number;
}

/** A half-open time range of the video to play sped-up. */
export interface Interval {
  startMs: number;
  endMs: number;
}

/**
 * Hard cap on sped-up intervals. Each interval costs two to three
 * filter_complex pieces (~60 chars each); 32 keeps the ffmpeg argument far
 * below the ~32k Windows command-line limit while covering any sane run.
 */
export const MAX_FAST_INTERVALS = 32;

/**
 * Intervals shorter than this are dropped: at 8x they save under a quarter
 * second of playback but cost two filter pieces and a visible time jump.
 */
export const MIN_INTERVAL_MS = 250;

/**
 * Collapse walk marks into disjoint, clamped walking intervals.
 *
 * Nested and overlapping walk segments are merged with a depth counter: the
 * interval opens on the first `walk:start` and closes when every start has
 * seen its end. A stray `walk:end` (no open segment) is ignored; an unmatched
 * `walk:start` is closed at video end.
 *
 * @param marks Walk marks in any order (sorted internally by time).
 * @param durationMs Total video duration; intervals are clamped to it.
 * @returns disjoint intervals sorted by start time, each at least
 * {@link MIN_INTERVAL_MS} long.
 */
export function computeWalkIntervals(
  marks: WalkMark[],
  durationMs: number,
): Interval[] {
  const sorted = [...marks].sort((a, b) => a.tMs - b.tMs);
  const intervals: Interval[] = [];
  let depth = 0;
  let openedAt = 0;
  for (const m of sorted) {
    if (m.message === "walk:start") {
      if (depth === 0) openedAt = m.tMs;
      depth++;
    } else if (m.message === "walk:end") {
      if (depth === 0) continue; // stray end: nothing to close
      depth--;
      if (depth === 0) intervals.push({ startMs: openedAt, endMs: m.tMs });
    }
  }
  if (depth > 0) intervals.push({ startMs: openedAt, endMs: durationMs });

  const clamped = intervals
    .map((iv) => ({
      startMs: Math.max(0, iv.startMs),
      endMs: Math.min(durationMs, iv.endMs),
    }))
    .filter((iv) => iv.endMs - iv.startMs >= MIN_INTERVAL_MS);

  // Clamping can make neighbours touch; keep the output disjoint.
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
 * Reduce the interval count to `cap` by merging the pair with the smallest
 * gap, repeatedly. The swallowed gap plays sped-up — a graceful degradation
 * when a run somehow produces an absurd number of walking legs.
 *
 * @param intervals Disjoint intervals sorted by start time.
 * @param cap Maximum number of intervals to keep.
 * @returns at most `cap` disjoint intervals.
 */
export function capIntervals(intervals: Interval[], cap: number): Interval[] {
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
    out[best - 1].endMs = out[best].endMs;
    out.splice(best, 1);
  }
  return out;
}

/**
 * Build the ffmpeg `filter_complex` that plays `intervals` at `factor`x and
 * everything else in real time: alternating trim+setpts pieces concatenated,
 * then re-timed to a constant 25 fps (Playwright's recording rate) so the
 * fast pieces do not carry a 200 fps stream into the output.
 *
 * The final piece is left open-ended (`trim=start=` with no `end`) so a
 * duration probe that slightly undershoots the real length never clips the
 * tail of the video.
 *
 * @param intervals Disjoint sped-up intervals sorted by start time.
 * @param durationMs Total video duration used to place the tail piece.
 * @param factor Speed-up factor for walking intervals (> 1).
 * @returns the filter graph string ending in `[out]`, or null when there is
 * nothing to speed up.
 */
export function buildTimelapseFilter(
  intervals: Interval[],
  durationMs: number,
  factor: number,
): string | null {
  if (intervals.length === 0 || factor <= 1) return null;
  const sec = (ms: number) => (ms / 1000).toFixed(3);

  interface Piece {
    startMs: number;
    endMs: number | null;
    fast: boolean;
  }
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const iv of intervals) {
    if (iv.startMs > cursor)
      pieces.push({ startMs: cursor, endMs: iv.startMs, fast: false });
    pieces.push({ startMs: iv.startMs, endMs: iv.endMs, fast: true });
    cursor = iv.endMs;
  }
  if (cursor < durationMs)
    pieces.push({ startMs: cursor, endMs: null, fast: false });
  pieces[pieces.length - 1].endMs = null;

  const parts: string[] = [];
  const labels: string[] = [];
  pieces.forEach((p, i) => {
    const trim =
      p.endMs === null
        ? `trim=start=${sec(p.startMs)}`
        : `trim=start=${sec(p.startMs)}:end=${sec(p.endMs)}`;
    const pts = p.fast
      ? `setpts=(PTS-STARTPTS)/${factor}`
      : `setpts=PTS-STARTPTS`;
    parts.push(`[0:v]${trim},${pts}[v${i}]`);
    labels.push(`[v${i}]`);
  });
  parts.push(`${labels.join("")}concat=n=${pieces.length}:v=1:a=0[cat]`);
  parts.push(`[cat]fps=25[out]`);
  return parts.join(";");
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
 * Filters the timelapse graph needs. Playwright's bundled ffmpeg is built
 * with `--disable-everything` and ships only pad/crop/scale (plus core trim)
 * — it cannot re-time video, so every candidate is probed before use.
 */
export const REQUIRED_FILTERS = ["trim", "setpts", "concat", "fps"] as const;

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
  filter?: string;
  inputDurationMs?: number;
  outputDurationMs?: number;
}

/**
 * Re-encode `videoPath` in place so walking intervals play at `factor`x.
 *
 * Never loses the video: any missing prerequisite (marks, ffmpeg, duration)
 * leaves the original untouched with a log line, and an ffmpeg failure
 * restores the original file. The untouched original survives as
 * `<name>-full.<ext>` beside the output when `keepRaw` is set.
 *
 * @param opts.videoPath The finalised run video (e.g. `run.webm`).
 * @param opts.marks Walk marks timed against the video timeline.
 * @param opts.factor Speed-up factor; values <= 1 disable the pass.
 * @param opts.keepRaw Keep the real-time original as `<name>-full.<ext>`.
 * @param opts.log Harness logger (info/warn).
 * @returns what happened, including the generated filter when applied.
 */
export function applyTimelapse(opts: {
  videoPath: string;
  marks: WalkMark[];
  factor: number;
  keepRaw: boolean;
  log: { info(m: string): void; warn(m: string): void };
}): TimelapseResult {
  const { videoPath, marks, factor, keepRaw, log } = opts;
  if (factor <= 1) return { applied: false, reason: "factor<=1" };

  const walkMarks = marks.filter(
    (m) => m.message === "walk:start" || m.message === "walk:end",
  );
  if (walkMarks.length === 0) {
    log.info("timelapse: no walk marks; leaving the video as-is");
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

  const intervals = capIntervals(
    computeWalkIntervals(walkMarks, durationMs),
    MAX_FAST_INTERVALS,
  );
  const filter = buildTimelapseFilter(intervals, durationMs, factor);
  if (!filter) {
    log.info("timelapse: no usable walk intervals; leaving the video as-is");
    return { applied: false, reason: "no intervals" };
  }

  const rawPath = rawSiblingPath(videoPath);
  renameSync(videoPath, rawPath);
  try {
    // Mirrors Playwright's own vp8 recording settings so quality/size match
    // the untouched parts of the run video. No audio track exists (-an).
    execFileSync(
      ff,
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        rawPath,
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-an",
        "-c:v",
        "libvpx",
        "-qmin",
        "0",
        "-qmax",
        "50",
        "-crf",
        "8",
        "-b:v",
        "1M",
        videoPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (err) {
    try {
      unlinkSync(videoPath); // partial output, if any
    } catch {
      /* ignore */
    }
    renameSync(rawPath, videoPath);
    log.warn(
      `timelapse: ffmpeg failed; keeping the real-time video (${String(err).split("\n")[0]})`,
    );
    return { applied: false, reason: "ffmpeg failed" };
  }

  const outputDurationMs = probeDurationMs(ff, videoPath);
  if (!keepRaw) {
    try {
      unlinkSync(rawPath);
    } catch {
      /* ignore */
    }
  }
  log.info(
    `timelapse: x${factor} over ${intervals.length} walk interval(s); ` +
      `${(durationMs / 1000).toFixed(1)}s -> ` +
      `${outputDurationMs ? (outputDurationMs / 1000).toFixed(1) : "?"}s` +
      (keepRaw ? `; raw kept at ${rawPath}` : ""),
  );
  return {
    applied: true,
    filter,
    inputDurationMs: durationMs,
    ...(outputDurationMs ? { outputDurationMs } : {}),
  };
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
