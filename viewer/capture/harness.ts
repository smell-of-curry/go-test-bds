import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserContext, Page } from "playwright";

import { applyTimelapse, type WalkMark } from "./timelapse";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface HarnessOptions {
  stream: string;
  bot: string;
  width: number;
  height: number;
  maxSegmentSeconds: number;
  browserPath: string;
  logLevel: LogLevel;
  /**
   * Speed-up factor for walking segments (mark phase `segment`,
   * `walk:start`/`walk:end`) applied to the run video after it is written.
   * Loading segments (`loading:start`/`loading:end`) are cut regardless.
   * 1 disables walk speed-up only. Only applies with {@link videoOut}.
   */
  timelapse: number;
  /** Keep the untouched real-time recording as `run-full.webm`. */
  keepRaw: boolean;
  /**
   * File to write the run video to. When unset the video is POSTed to the bot
   * instead, which only works while the bot is still running.
   */
  videoOut?: string;
}

interface MarkState {
  runId?: string;
  suite?: string;
  test?: string;
}

/** Set once the run has something to close; null before and after. */
let shutdownHandler: (() => void) | null = null;
/** True when a shutdown was asked for before there was anything to close. */
let shutdownPending = false;

/**
 * Register (or clear) what a shutdown request should close.
 *
 * @param handler Closes the stream so the run unwinds normally, or null to clear.
 */
function setShutdownHandler(handler: (() => void) | null): void {
  shutdownHandler = handler;
  if (handler && shutdownPending) {
    shutdownPending = false;
    handler();
  }
}

/**
 * Ask the harness to finish: close the stream, write the video, exit.
 *
 * Safe before the browser is up — the request is remembered and applied as soon
 * as there is a stream to close. The CLI calls this from its signal handlers, so
 * a terminated run still produces its recording.
 */
export function requestHarnessShutdown(): void {
  if (shutdownHandler) {
    shutdownHandler();
    return;
  }
  shutdownPending = true;
}

interface CaptureFrame {
  type: "capture";
  id: string;
  minTick: number;
  timeoutMs?: number;
  /** Skip the mesh-settle grace: short-lived UI (a ~4s title card) loses the
   * race against a 10s settle wait, and a card shot needs speed, not mesh
   * completeness. */
  noSettle?: boolean;
  ext?: string;
  label?: string;
  bot?: string;
}

interface MarkFrame {
  type: "mark";
  phase: string;
  status?: string;
  runId?: string;
  suite?: string;
  test?: string;
  message?: string;
  tick?: number;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Fallback only. The deadline belongs to the caller of the `screenshot`
// instruction and rides on the capture frame; giving up sooner than the waiting
// Go side would fail a capture it was still willing to wait for.
const DEFAULT_CAPTURE_TIMEOUT_MS = 5_000;

/**
 * How long a still may wait for the scene to finish meshing after its target
 * tick has rendered. Best-effort: a busy mesher (world still streaming) must
 * not cost the still entirely.
 */
const SETTLE_GRACE_MS = 10_000;
const GL_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  // The stills page lives behind the video page. Chromium throttles rAF and
  // timers in backgrounded pages, which froze the stills page's tick and made
  // every still time out with "no canvas frame reached tick N" while the
  // video page rendered those same ticks fine.
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
];

/**
 * Run the capture harness until the SSE stream closes.
 *
 * One BrowserContext records the whole run (stills + video). Playwright only
 * finalises `recordVideo` on context close, so per-test contexts produced blank
 * ~3 KB webms when short tests ended before the app loaded.
 *
 * @param opts - Resolved CLI options including an existing browser binary.
 * @returns resolves when the stream closes cleanly.
 * @throws if the browser or stills page cannot start.
 */
export async function runHarness(opts: HarnessOptions): Promise<void> {
  const log = makeLogger(opts.logLevel);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chromium } = require("playwright") as typeof import("playwright");

  const browser = await chromium.launch({
    executablePath: opts.browserPath,
    headless: true,
    args: GL_ARGS,
    // Playwright closes the browser itself on these signals by default, which
    // races the shutdown that writes the run video: the runner sends SIGTERM,
    // the browser goes away, and saving the recording fails with "browser has
    // been closed". This process owns its own shutdown instead.
    handleSIGTERM: false,
    handleSIGINT: false,
    handleSIGHUP: false,
  });

  // Follow camera is the capture default so the bot body and its surroundings
  // are in frame; override with ?camera=first|orbit on a human URL.
  const appUrl = `${opts.stream}/?bot=${encodeURIComponent(opts.bot)}&camera=follow`;
  const mark: MarkState = {};
  const videoDir = mkdtempSync(join(tmpdir(), "gotestbds-capture-"));
  const videoStartedAt = Date.now();

  let stillsCtx: BrowserContext = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    recordVideo: {
      dir: videoDir,
      size: { width: opts.width, height: opts.height },
    },
  });
  let stillsPage: Page = await stillsCtx.newPage();

  // Video t=0 anchor for walk marks. Playwright starts the screencast when the
  // context's first page opens (about:blank paints immediately) and paces the
  // saved webm by wall clock from its first frame, so Date.now() at newPage
  // resolution tracks the video timeline. Measured by flipping the page colour
  // at known wall-clock offsets and locating the flips in the saved video:
  // events sit ~110ms earlier in the video than on this anchor's clock
  // (stable at 103-114ms over 8s, two runs, no drift), so walk intervals land
  // ~0.1s late — well inside the ±1s an 8x walking segment tolerates.
  const videoAnchorMs = Date.now();
  const walkMarks: WalkMark[] = [];

  // A browser that dies mid-run explains every later failure at once — captures
  // that time out, a video that cannot be saved — and says nothing by itself.
  let browserDown = "";
  browser.on("disconnected", () => {
    browserDown = "browser disconnected";
    log.error("capture: browser disconnected");
  });
  stillsPage.on("crash", () => {
    browserDown = "page crashed";
    log.error("capture: page crashed (out of memory under software GL?)");
  });
  stillsPage.on("pageerror", (err) => {
    log.warn(`capture: page error: ${err.message}`);
  });

  // Subscribe before the page so marks/captures cannot race past us while the
  // stills page is still loading. Queue until stillsReady. Each item carries
  // its arrival time: walk marks are timed against the video, and processing
  // (or replaying the pre-ready queue) can lag arrival by seconds.
  let stillsReady = false;
  const pending: Array<{ type: string; data: string; at: number }> = [];
  let chain: Promise<void> = Promise.resolve();
  let videoUploaded = false;

  const uploadRunVideo = async (label: string): Promise<void> => {
    if (videoUploaded) return;
    videoUploaded = true;
    const ctx = stillsCtx;
    const page = stillsPage;
    try {
      const video = page.video();
      // Close the page, keep the context: saveAs waits for the recording to be
      // finalised and needs a live connection to do it. Closing the context
      // first tears that down and saveAs fails with "browser has been closed".
      await page.close().catch(() => undefined);
      if (!video) {
        await ctx.close().catch(() => undefined);
        log.warn("capture: no video handle after run");
        return;
      }
      const durationMs = Date.now() - videoStartedAt;

      // Writing the file beats posting it when we have somewhere to put it: the
      // bot hosts the upload endpoint and exits as soon as the run finishes, so
      // a recording finalised at shutdown has nothing left to POST to. The
      // runner reconciles the artefact directory once everything is down.
      //
      // saveAs, not a read of video.path(): the path exists as soon as recording
      // starts and ffmpeg is still writing it, so reading it directly hands back
      // whatever has been flushed — a recording that stopped on a block boundary
      // (exactly 512 KiB, in the run that found this).
      if (opts.videoOut) {
        mkdirSync(dirname(opts.videoOut), { recursive: true });
        await video.saveAs(opts.videoOut);
        const bytes = statSync(opts.videoOut).size;
        log.info(
          `capture: wrote video ${opts.videoOut} bytes=${bytes} ms=${durationMs}`,
        );
        await video.delete().catch(() => undefined);
        await ctx.close().catch(() => undefined);
        // Speed up the marked walking legs now that the file is final. Sync
        // ffmpeg is fine here: the run is over and nothing else is waiting.
        applyTimelapse({
          videoPath: opts.videoOut,
          marks: walkMarks,
          factor: opts.timelapse,
          keepRaw: opts.keepRaw,
          log,
        });
        return;
      }
      // ponytail: the POST path (no --video-out) skips the timelapse pass —
      // the runner always passes --video-out, and the POST target (the bot's
      // own HTTP server) is already racing its exit at this point.
      await ctx.close().catch(() => undefined);

      const path = await video.path();
      const body = readFileSync(path);

      await postArtifact(opts.stream, {
        kind: "video",
        ext: "webm",
        bot: opts.bot,
        body,
        width: opts.width,
        height: opts.height,
        durationMs,
        runId: mark.runId,
        suite: mark.suite,
        test: mark.test,
        label,
      });
      log.info(
        `capture: uploaded video run=${mark.runId ?? ""} bytes=${body.length} label=${label}`,
      );
      try {
        unlinkSync(path);
      } catch {
        /* ignore */
      }
    } catch (err) {
      log.warn(
        `capture: video upload failed: ${String(err)}` +
          (browserDown ? ` (${browserDown} earlier in the run)` : ""),
      );
    } finally {
      try {
        rmSync(videoDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };

  const onFrame = async (
    type: string,
    data: string,
    atMs: number,
  ): Promise<void> => {
    let frame: { type: string };
    try {
      frame = JSON.parse(data) as { type: string };
    } catch (err) {
      log.warn(`capture: bad frame JSON: ${String(err)}`);
      return;
    }

    if (type === "mark" || frame.type === "mark") {
      await safe(log, () =>
        handleMark(frame as MarkFrame, atMs, {
          opts,
          log,
          stillsPage,
          mark,
          videoAnchorMs,
          walkMarks,
          // `sse` is declared below but only ever called once frames arrive.
          endRun: () => sse.close(),
        }),
      );
      return;
    }

    if (type === "capture" || frame.type === "capture") {
      await safe(log, () =>
        handleCapture(frame as CaptureFrame, {
          opts,
          log,
          stillsPage,
          mark,
        }),
      );
    }
  };

  const enqueue = (type: string, data: string, at = Date.now()): void => {
    if (!stillsReady) {
      if (type === "mark" || type === "capture")
        pending.push({ type, data, at });
      return;
    }
    chain = chain.then(() => onFrame(type, data, at));
  };

  const sse = subscribeSse(
    `${opts.stream}/stream?bot=${encodeURIComponent(opts.bot)}`,
    log,
  );
  sse.onEvent = enqueue;

  const capTimer = setTimeout(() => {
    log.info(
      `capture: max-segment-seconds=${opts.maxSegmentSeconds} reached; uploading run video`,
    );
    // Force end: close SSE so the main loop unwinds and finally uploads once.
    sse.close();
  }, opts.maxSegmentSeconds * 1000);
  if (typeof capTimer.unref === "function") capTimer.unref();

  // The runner kills this process once the bot exits, and the signal handler is
  // registered by the CLI before anything else exists, because a signal that
  // arrives while the browser is still starting must not kill the process
  // outright — that loses the recording. Hand it the stream to close and let the
  // normal path unwind and write the video.
  setShutdownHandler(() => sse.close());

  try {
    await stillsPage.goto(appUrl, { waitUntil: "domcontentloaded" });
    try {
      await stillsPage.waitForFunction(
        () => {
          const v = (
            window as unknown as {
              __viewer?: { schemaOk: boolean; tick: number };
            }
          ).__viewer;
          return !!v && v.schemaOk && v.tick > 0;
        },
        undefined,
        { timeout: 30_000 },
      );
    } catch (err) {
      const diag = await stillsPage
        .evaluate(() => {
          const v = (
            window as unknown as {
              __viewer?: {
                schemaOk: boolean;
                tick: number;
                framesReceived: number;
                lastError: string | null;
              };
            }
          ).__viewer;
          if (!v) return { missing: true as const };
          return {
            missing: false as const,
            schemaOk: v.schemaOk,
            tick: v.tick,
            framesReceived: v.framesReceived,
            lastError: v.lastError,
          };
        })
        .catch(() => ({ missing: true as const }));
      log.error(
        `capture: stills readiness timeout diag=${JSON.stringify(diag)}`,
      );
      throw err;
    }
    log.info(`capture: stills attached at ${appUrl}`);
    stillsReady = true;
    for (const p of pending) enqueue(p.type, p.data, p.at);
    pending.length = 0;

    await sse.done.catch(() => undefined);
    await chain.catch(() => undefined);
    log.info("capture: stream closed");
  } finally {
    clearTimeout(capTimer);
    setShutdownHandler(null);
    await safe(log, async () => {
      await uploadRunVideo("run");
    });
    await browser.close().catch(() => undefined);
  }
}

async function handleMark(
  frame: MarkFrame,
  atMs: number,
  ctx: {
    opts: HarnessOptions;
    log: Logger;
    stillsPage: Page;
    mark: MarkState;
    videoAnchorMs: number;
    walkMarks: WalkMark[];
    endRun: () => void;
  },
): Promise<void> {
  if (frame.runId !== undefined) ctx.mark.runId = frame.runId;
  if (frame.suite !== undefined) ctx.mark.suite = frame.suite;
  if (frame.test !== undefined) ctx.mark.test = frame.test;

  // Walk / loading legs, timed against the video for the timelapse pass
  // after the recording is written. `segment` marks are timeline metadata
  // only — message strings pass through untouched.
  if (
    frame.phase === "segment" &&
    (frame.message === "walk:start" ||
      frame.message === "walk:end" ||
      frame.message === "loading:start" ||
      frame.message === "loading:end")
  ) {
    ctx.walkMarks.push({
      message: frame.message,
      tMs: atMs - ctx.videoAnchorMs,
    });
    return;
  }

  // Video is one continuous recording for the run; marks only update the
  // burnt-in overlay (via the app's SSE) and failure stills.
  if (frame.phase === "testEnd" && frame.status === "failed") {
    await uploadFailureStill(ctx.stillsPage, ctx.opts, ctx.mark, ctx.log);
  }

  // Finish on the run's own last word rather than waiting to be killed: the
  // upload needs the bot still listening, and by the time the runner tears the
  // harness down the bot is already going away.
  if (frame.phase === "runEnd") {
    ctx.log.info("capture: runEnd; finishing the run video");
    ctx.endRun();
  }
}

async function handleCapture(
  frame: CaptureFrame,
  ctx: {
    opts: HarnessOptions;
    log: Logger;
    stillsPage: Page;
    mark: MarkState;
  },
): Promise<void> {
  const { opts, log, stillsPage, mark } = ctx;
  const minTick = frame.minTick;
  const timeoutMs = frame.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  try {
    await stillsPage.waitForFunction(
      (need) => {
        const v = (
          window as unknown as {
            __viewer?: {
              schemaOk: boolean;
              tick: number;
              assetsSettled: boolean;
            };
          }
        ).__viewer;
        // assetsSettled = atlas ready OR failed (placeholder fallback). Still
        // must not fire while the deliberate loading screen is up.
        return !!v && v.schemaOk && v.tick >= need && v.assetsSettled;
      },
      minTick,
      // Timer polling, not the default rAF: a backgrounded page may never
      // grant an animation frame, and the predicate has to keep running.
      { timeout: timeoutMs, polling: 250 },
    );
    await stillsPage.evaluate(() => {
      (
        window as unknown as { __viewer?: { flush: () => void } }
      ).__viewer?.flush();
    });
    // Settling is best-effort: while the world is still streaming columns the
    // mesher never goes idle, so a hard wait here starved run 15's subway
    // still for its whole budget ("Timeout 30000ms exceeded" — the Playwright
    // default, not ours). The first gate already proved the wanted tick was
    // rendered; a still with a few unmeshed far columns beats no still.
    // noSettle skips even the grace — a ~4s title card loses that race.
    if (!frame.noSettle) {
      await stillsPage
        .waitForFunction(
          () =>
            (window as unknown as { __viewer?: { settled: boolean } }).__viewer
              ?.settled === true,
          undefined,
          { polling: 250, timeout: SETTLE_GRACE_MS },
        )
        .catch(() => {
          log.warn(
            `capture: scene still meshing after ${SETTLE_GRACE_MS}ms; capturing anyway`,
          );
        });
    } else if ((frame.label ?? "").includes("complete")) {
      // Server getPhudToken sees the completion card before the title packet
      // reaches the bot/viewer. Wait for the SSE lane (or the painted card)
      // so showcase-07 doesn't shoot an empty loadingScreen clear.
      await stillsPage
        .waitForFunction(
          () => {
            const v = (
              window as unknown as {
                __viewer?: { phud?: Record<string, string> };
              }
            ).__viewer;
            const text = v?.phud?.loadingScreen ?? "";
            if (text.includes("TUTORIAL COMPLETE")) return true;
            const el = document.querySelector(
              '[data-jsonui-name="phud_loadingScreen.main"]',
            );
            return (el?.textContent ?? "").includes("TUTORIAL COMPLETE");
          },
          undefined,
          { polling: 100, timeout: 8_000 },
        )
        .catch(() => {
          log.warn(
            "capture: loadingScreen card never reached the viewer; capturing anyway",
          );
        });
    }

    const tick = await stillsPage.evaluate(
      () => (window as unknown as { __viewer: { tick: number } }).__viewer.tick,
    );
    const png = await stillsPage.screenshot({ type: "png" });
    await postArtifact(opts.stream, {
      kind: "screenshot",
      ext: "png",
      bot: opts.bot,
      body: Buffer.from(png),
      captureId: frame.id,
      tick,
      width: opts.width,
      height: opts.height,
      runId: mark.runId,
      suite: mark.suite,
      test: mark.test,
      label: frame.label,
    });
    await uploadJsonUiDump(stillsPage, opts, mark, frame.label, tick, log);
    log.info(`capture: uploaded still id=${frame.id} tick=${tick}`);
  } catch (err) {
    // Carry the real error: run 15 reported "within 239999ms" for a failure
    // that was actually a 30s default timeout on a different wait.
    const message =
      `no canvas frame reached tick ${minTick} within ${timeoutMs}ms ` +
      `(${String(err).split("\n")[0]?.slice(0, 160)})`;
    log.warn(`capture: ${message}`);
    await postCaptureError(opts.stream, frame.id, message).catch((e) =>
      log.warn(`capture: error POST failed: ${String(e)}`),
    );
  }
}

async function uploadFailureStill(
  page: Page,
  opts: HarnessOptions,
  mark: MarkState,
  log: Logger,
): Promise<void> {
  try {
    await page.evaluate(() => {
      (
        window as unknown as { __viewer?: { flush: () => void } }
      ).__viewer?.flush();
    });
    const tick = await page.evaluate(
      () =>
        (window as unknown as { __viewer?: { tick: number } }).__viewer?.tick ??
        0,
    );
    const png = await page.screenshot({ type: "png" });
    await postArtifact(opts.stream, {
      kind: "screenshot",
      ext: "png",
      bot: opts.bot,
      body: Buffer.from(png),
      tick,
      width: opts.width,
      height: opts.height,
      runId: mark.runId,
      suite: mark.suite,
      test: mark.test,
      label: "failure",
    });
    await uploadJsonUiDump(page, opts, mark, "failure", tick, log);
    log.info(`capture: uploaded failure still tick=${tick}`);
  } catch (err) {
    log.warn(`capture: failure still failed: ${String(err)}`);
  }
}

/**
 * Dump visible JSON UI nodes next to a still (always-on, best-effort).
 *
 * @param page - Playwright page with `__viewer.debugJsonUiDump`.
 * @param opts - Harness options (stream / bot / size).
 * @param mark - Current run/suite/test.
 * @param label - Still label (becomes `<label>-jsonui.json`).
 * @param tick - World tick at capture.
 * @param log - Logger.
 */
async function uploadJsonUiDump(
  page: Page,
  opts: HarnessOptions,
  mark: MarkState,
  label: string | undefined,
  tick: number,
  log: Logger,
): Promise<void> {
  try {
    const dump = await page.evaluate(() => {
      const v = (
        window as unknown as {
          __viewer?: { debugJsonUiDump?: () => unknown };
        }
      ).__viewer;
      return v?.debugJsonUiDump?.() ?? null;
    });
    if (!dump) {
      log.warn("capture: jsonui dump skipped (no debugJsonUiDump)");
      return;
    }
    const body = Buffer.from(JSON.stringify(dump), "utf8");
    const base = label && label.length > 0 ? label : "still";
    await postArtifact(opts.stream, {
      kind: "jsonui-dump",
      ext: "json",
      bot: opts.bot,
      body,
      tick,
      width: opts.width,
      height: opts.height,
      runId: mark.runId,
      suite: mark.suite,
      test: mark.test,
      label: `${base}-jsonui`,
    });
    log.info(
      `capture: uploaded jsonui dump label=${base}-jsonui bytes=${body.length}`,
    );
  } catch (err) {
    log.warn(`capture: jsonui dump failed: ${String(err)}`);
  }
}

interface ArtifactHeaders {
  kind: "screenshot" | "video" | "jsonui-dump";
  ext: "png" | "webm" | "json";
  bot: string;
  body: Buffer;
  captureId?: string;
  tick?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  runId?: string;
  suite?: string;
  test?: string;
  label?: string;
}

/**
 * POST artefact bytes to the bot's `/artifact` endpoint.
 *
 * @param base - Viewer base URL (no trailing slash).
 * @param art - Artefact bytes + header metadata.
 * @returns resolves on HTTP 2xx.
 * @throws on non-2xx responses or network failure.
 */
export async function postArtifact(
  base: string,
  art: ArtifactHeaders,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(art.body.length),
    "X-Artifact-Kind": art.kind,
    "X-Artifact-Ext": art.ext,
    "X-Artifact-Bot": art.bot,
  };
  if (art.captureId !== undefined) headers["X-Capture-Id"] = art.captureId;
  if (art.tick !== undefined) headers["X-Artifact-Tick"] = String(art.tick);
  if (art.width !== undefined) headers["X-Artifact-Width"] = String(art.width);
  if (art.height !== undefined)
    headers["X-Artifact-Height"] = String(art.height);
  if (art.durationMs !== undefined)
    headers["X-Artifact-Duration-Ms"] = String(art.durationMs);
  if (art.runId !== undefined) headers["X-Artifact-Run"] = art.runId;
  if (art.suite !== undefined) headers["X-Artifact-Suite"] = art.suite;
  if (art.test !== undefined) headers["X-Artifact-Test"] = art.test;
  if (art.label !== undefined) headers["X-Artifact-Label"] = art.label;

  const res = await httpRequest(`${base}/artifact`, {
    method: "POST",
    headers,
    body: art.body,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `POST /artifact → ${res.status}: ${res.body.toString("utf8")}`,
    );
  }
}

/**
 * Report a failed capture attempt.
 *
 * @param base - Viewer base URL.
 * @param id - Capture id from the `capture` frame.
 * @param message - Human-readable failure reason.
 * @returns resolves on HTTP 2xx.
 * @throws on non-2xx responses or network failure.
 */
export async function postCaptureError(
  base: string,
  id: string,
  message: string,
): Promise<void> {
  const body = Buffer.from(JSON.stringify({ message }), "utf8");
  const res = await httpRequest(
    `${base}/capture/${encodeURIComponent(id)}/error`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
      },
      body,
    },
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `POST /capture/${id}/error → ${res.status}: ${res.body.toString("utf8")}`,
    );
  }
}

type Logger = {
  debug: (m: string) => void;
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
};

function makeLogger(level: LogLevel): Logger {
  const min = LEVEL_RANK[level] ?? LEVEL_RANK.info;
  const emit = (lvl: LogLevel, m: string) => {
    if (LEVEL_RANK[lvl] < min) return;
    const line = `${m}\n`;
    if (lvl === "error" || lvl === "warn") process.stderr.write(line);
    else process.stdout.write(line);
  };
  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
  };
}

async function safe(log: Logger, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn(`capture: swallowed: ${String(err)}`);
  }
}

function subscribeSse(
  url: string,
  log: Logger,
): {
  done: Promise<void>;
  onEvent: ((type: string, data: string) => void) | null;
  close: () => void;
} {
  let onEvent: ((type: string, data: string) => void) | null = null;
  let req: http.ClientRequest | null = null;

  const done = new Promise<void>((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    req = lib.get(url, { headers: { Accept: "text/event-stream" } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`SSE ${url} → ${res.statusCode}`));
        res.resume();
        return;
      }
      log.debug(`capture: SSE open ${url}`);
      let buf = "";
      let event = "message";
      let dataLines: string[] = [];
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        for (;;) {
          const nl = buf.indexOf("\n");
          if (nl < 0) break;
          let line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":")) continue;
          if (line === "") {
            if (dataLines.length > 0) {
              onEvent?.(event, dataLines.join("\n"));
            }
            event = "message";
            dataLines = [];
            continue;
          }
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
            continue;
          }
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      });
      res.on("end", () => resolve());
      res.on("error", (err) => {
        log.warn(`capture: SSE error: ${String(err)}`);
        resolve();
      });
    });
    req.on("error", (err) => {
      // Connection failure before start is a start failure.
      reject(err);
    });
  });

  return {
    done,
    get onEvent() {
      return onEvent;
    },
    set onEvent(fn) {
      onEvent = fn;
    },
    close: () => {
      req?.destroy();
    },
  };
}

function httpRequest(
  url: string,
  init: { method: string; headers: Record<string, string>; body: Buffer },
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      { method: init.method, headers: init.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}
