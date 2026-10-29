import type { FilmCameraKeyframe } from "../src/camera";
import { rewriteTimelineForLookahead, type LookaheadPoint } from "./lookahead";
import type { Frame } from "../src/protocol";

/** Page-side film control. The CLI drives the Playwright clock and calls these. */
export interface FilmPage {
  ready: boolean;
  loaded: boolean;
  /** True once pack load has settled (ready or failed). */
  bootstrapped: boolean;
  error: string | null;
  /** `ready`, or the asset-load error (placeholder terrain). */
  assetNote: string;
  meta: { firstTick: number; lastTick: number; frames: number } | null;
  applyThrough(targetMs: number): void;
  /**
   * Pin `performance.now` to this millisecond. The Playwright clock is paused
   * and stepped too, but its install log replays a 1 ms wall gap into the
   * ticks, so the picture reads this value instead.
   */
  setNow(ms: number): void;
  /** Draw the frame at the current virtual clock and return PNG base64. */
  present(): string;
  setCamera(track: FilmCameraKeyframe[] | null): void;
  /**
   * Film-only. Pull in-bubble columns forward and keep them through `toMs`.
   * No-op when `enabled` is false or frames have already been applied.
   */
  prepareLookahead(opts: {
    fromMs: number;
    toMs: number;
    cameraPoints?: LookaheadPoint[];
    radiusChunks?: number;
    enabled?: boolean;
  }): void;
  renderer(): string;
}

declare global {
  interface Window {
    __film?: FilmPage;
  }
}

export interface FilmHooks {
  applyFrame(frame: Frame): void;
  setCameraTrack(track: readonly FilmCameraKeyframe[] | null): void;
  paint(): void;
  canvas: HTMLCanvasElement;
  glFinish(): void;
  hideChrome(): void;
}

interface TimedFrame {
  tMs: number;
  frame: Frame;
}

/**
 * Mulberry32 in `[0, 1)`. Film mode seeds particles with `1` and `Math.random`
 * with `2` so both streams are fixed and independent.
 *
 * @param seed - Unsigned seed.
 * @returns a `next()` source.
 */
export function createFilmRandom(seed: number): { next(): number } {
  let s = seed >>> 0;
  return {
    next(): number {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Incremental SSE reader. Feed decoded text chunks; a line split across
 * chunks stays in the carry buffer so the whole take is never one string.
 */
export interface SseParser {
  /** @param chunk - Newly decoded text. @returns events finished by this chunk. */
  push(chunk: string): SseEvent[];
  /** Flush a trailing line that had no final newline. */
  finish(): SseEvent[];
}

/**
 * @returns a parser. Comment lines are dropped. Non-JSON data is skipped.
 */
export function createSseParser(): SseParser {
  let event = "message";
  const data: string[] = [];
  let carry = "";

  const flush = (bucket: SseEvent[]): void => {
    if (data.length === 0) {
      event = "message";
      return;
    }
    const raw = data.join("\n");
    data.length = 0;
    const name = event;
    event = "message";
    try {
      bucket.push({ event: name, data: JSON.parse(raw) as unknown });
    } catch {
      /* skip a non-JSON keepalive leftover */
    }
  };

  const pushLine = (rawLine: string, bucket: SseEvent[]): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      flush(bucket);
      return;
    }
    if (line.startsWith(":")) return;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      return;
    }
    if (line.startsWith("data:")) {
      const rest = line.slice(5);
      data.push(rest.startsWith(" ") ? rest.slice(1) : rest);
    }
  };

  return {
    push(chunk: string): SseEvent[] {
      const bucket: SseEvent[] = [];
      const text = carry + chunk;
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) pushLine(line, bucket);
      return bucket;
    },
    finish(): SseEvent[] {
      const bucket: SseEvent[] = [];
      if (carry.length > 0) {
        pushLine(carry, bucket);
        carry = "";
      }
      flush(bucket);
      return bucket;
    },
  };
}

/**
 * Parse an SSE document into events. Comment lines are dropped.
 *
 * @param text - Raw `text/event-stream` body.
 * @returns events in order.
 */
export function parseSse(text: string): SseEvent[] {
  const parser = createSseParser();
  return [...parser.push(text), ...parser.finish()];
}

/**
 * Place each SSE frame on the virtual timeline.
 *
 * `tMs = (tick - firstKeyframeTick) * 50`. Frames without a tick (hello) sit
 * at 0. Tick rate is the protocol's 20 Hz.
 *
 * @param text - SSE body.
 * @returns ordered frames plus the keyframe tick span.
 */
export function timelineFromSse(text: string): {
  frames: TimedFrame[];
  firstTick: number;
  lastTick: number;
} {
  return timelineFromEvents(parseSse(text));
}

/**
 * Same timeline as {@link timelineFromSse}, reading the body in chunks so a
 * take larger than V8's max string (~512MB) can still parse.
 *
 * @param stream - `fetch` response body.
 * @returns ordered frames plus the keyframe tick span.
 */
export async function timelineFromSseStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ frames: TimedFrame[]; firstTick: number; lastTick: number }> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const parser = createSseParser();
  const events: SseEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    events.push(...parser.push(dec.decode(value, { stream: true })));
  }
  events.push(...parser.push(dec.decode()));
  events.push(...parser.finish());
  return timelineFromEvents(events);
}

function timelineFromEvents(events: readonly SseEvent[]): {
  frames: TimedFrame[];
  firstTick: number;
  lastTick: number;
} {
  let firstTick: number | null = null;
  for (const ev of events) {
    const data = ev.data;
    if (!data || typeof data !== "object") continue;
    const rec = data as { type?: unknown; tick?: unknown };
    if (rec.type === "keyframe" && typeof rec.tick === "number") {
      firstTick = rec.tick;
      break;
    }
  }
  const base = firstTick ?? 0;
  let last = base;
  const frames: TimedFrame[] = [];
  for (const ev of events) {
    const data = ev.data;
    if (!data || typeof data !== "object") continue;
    const frame = data as Frame;
    const tick =
      "tick" in frame && typeof frame.tick === "number" ? frame.tick : null;
    if (tick !== null && tick > last) last = tick;
    const tMs = tick === null ? 0 : Math.max(0, (tick - base) * 50);
    frames.push({ tMs, frame });
  }
  return { frames, firstTick: base, lastTick: last };
}

/**
 * Install `window.__film`. Does not open an EventSource.
 *
 * `performance.now` stays the Playwright clock except while a recorded frame
 * is applied, when it reports that frame's tick time so motion lerp starts
 * on the virtual timeline.
 *
 * @param hooks - Live viewer pieces owned by `main.ts`.
 */
export function installFilmMode(hooks: FilmHooks): void {
  let virtualNow = 0;
  let spoof: number | null = null;
  // Playwright's paused clock still picks up 1 ms of wall time between
  // install and pauseAt, so two runs do not share a tick. The film clock is
  // this counter. setTimeout / rAF stay on the Playwright clock (paused).
  const perf = performance as Performance & { now: () => number };
  perf.now = () => (spoof !== null ? spoof : virtualNow);
  const pageRandom = createFilmRandom(2);
  (Math as { random: () => number }).random = () => pageRandom.next();

  let frames: TimedFrame[] = [];
  let cursor = 0;

  const applyThrough = (targetMs: number): void => {
    while (cursor < frames.length && frames[cursor]!.tMs <= targetMs + 1e-6) {
      const item = frames[cursor]!;
      cursor++;
      spoof = item.tMs;
      try {
        hooks.applyFrame(item.frame);
      } finally {
        spoof = null;
      }
    }
  };

  const page: FilmPage = {
    ready: true,
    loaded: false,
    bootstrapped: false,
    error: null,
    assetNote: "",
    meta: null,
    applyThrough,
    setNow(ms: number) {
      virtualNow = ms;
    },
    present(): string {
      applyThrough(virtualNow);
      hooks.hideChrome();
      const viewer = window.__viewer;
      // Drain the remesh queue completely. A capped flush leaves the floor
      // half-meshed on the frame that lookahead just made visible.
      if (viewer) {
        for (let i = 0; i < 10000 && !viewer.settled; i++) viewer.flush();
      }
      hooks.paint();
      hooks.glFinish();
      const url = hooks.canvas.toDataURL("image/png");
      const comma = url.indexOf(",");
      return comma >= 0 ? url.slice(comma + 1) : url;
    },
    setCamera(track) {
      hooks.setCameraTrack(track);
    },
    prepareLookahead(opts) {
      if (opts.enabled === false || cursor !== 0) return;
      frames = rewriteTimelineForLookahead(frames, {
        fromMs: opts.fromMs,
        toMs: opts.toMs,
        points: opts.cameraPoints ?? [],
        radiusChunks: opts.radiusChunks,
      });
    },
    renderer(): string {
      const gl =
        hooks.canvas.getContext("webgl2") ?? hooks.canvas.getContext("webgl");
      if (!gl) return "no-webgl";
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (!ext) return "unknown";
      return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    },
  };
  window.__film = page;

  const bot = new URLSearchParams(location.search).get("bot") ?? "";
  void fetch(`/film/sse?bot=${encodeURIComponent(bot)}`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`GET /film/sse → ${res.status}`);
      if (!res.body) throw new Error("GET /film/sse has no body");
      return timelineFromSseStream(res.body);
    })
    .then((timeline) => {
      frames = timeline.frames;
      cursor = 0;
      page.meta = {
        firstTick: timeline.firstTick,
        lastTick: timeline.lastTick,
        frames: timeline.frames.length,
      };
      if (timeline.frames.length === 0) {
        page.error = "take SSE has no frames";
      }
    })
    .catch((err: unknown) => {
      page.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      page.loaded = true;
    });
}
