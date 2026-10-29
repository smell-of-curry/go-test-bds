import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { sampleTrackPoints } from "./lookahead";
import { boundToMs, outputTimes, parseBound } from "./time";

export interface RenderFilmOptions {
  takeDir: string;
  bot: string;
  /** Seconds (`1.5` / `1.5s`) or ticks (`30t` / `30tick`). */
  from: string;
  to: string;
  width: number;
  height: number;
  fps: number;
  /** Directory of PNGs, or an `.mp4` path (PNGs land in a sibling `frames/`). */
  out: string;
  cameraPath?: string;
  /** ANGLE Metal instead of SwiftShader. */
  gpu?: boolean;
  hud?: boolean;
  nametags?: boolean;
  /** Also hide these player names. Default none. */
  hide?: string;
  /** Draw the recording bot. Default hides it. */
  showSelf?: boolean;
  /** Pull later columns forward. Default on. */
  lookahead?: boolean;
  /** Serve the Vite dev app instead of `appDir`. */
  dev?: boolean;
  /** Live hub origin. Misses are saved under `<take>/packs-mirror/`. */
  packsFrom?: string;
  appDir?: string;
}

export interface RenderFilmResult {
  frames: number;
  width: number;
  height: number;
  /** Wall seconds spent presenting output frames (not browser launch). */
  seconds: number;
  fps: number;
  renderer: string;
  frameDir: string;
  mp4: string | null;
}

/**
 * Render a take offline. Virtual time is the Playwright clock; the page applies
 * SSE frames whose tick has come due and reads the canvas in the same turn.
 *
 * @param opts - CLI options.
 * @returns frame count and where the files landed.
 */
export async function renderFilm(
  opts: RenderFilmOptions,
): Promise<RenderFilmResult> {
  const serverPath = fileURLToPath(
    new URL("../tools/film-server.mjs", import.meta.url),
  );
  const mod = (await import(pathToFileURL(serverPath).href)) as {
    startFilmServer: (opts: {
      takeDir: string;
      dev?: boolean;
      appDir?: string;
      packsFrom?: string;
    }) => Promise<{ url: string; close: () => Promise<void> }>;
  };
  const server = await mod.startFilmServer({
    takeDir: opts.takeDir,
    dev: opts.dev,
    appDir: opts.appDir,
    packsFrom: opts.packsFrom,
  });
  const mp4 = opts.out.endsWith(".mp4") ? opts.out : null;
  const frameDir = mp4 ? join(dirname(mp4), "frames") : opts.out;
  mkdirSync(frameDir, { recursive: true });
  if (mp4) mkdirSync(dirname(mp4), { recursive: true });

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      args: chromiumArgs(opts.gpu === true),
    });
    const page = await browser.newPage({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (err) => {
      console.error(`film pageerror: ${err.message}`);
    });
    // install() resumes wall-clock sync on the first performance.now() unless a
    // pauseAt is in the log. Pause before navigation so load time cannot skip ticks.
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(0);
    const q = new URLSearchParams({ film: "1", bot: opts.bot });
    if (opts.hud) q.set("hud", "1");
    if (opts.nametags) q.set("nametags", "1");
    if (opts.showSelf) q.set("showSelf", "1");
    if (opts.hide) q.set("hide", opts.hide);
    if (opts.lookahead === false) q.set("lookahead", "0");
    await page.goto(`${server.url}/?${q.toString()}`, { waitUntil: "load" });
    await page.waitForFunction(
      () => window.__film?.loaded === true,
      undefined,
      {
        timeout: 30_000,
      },
    );
    const loaded = await page.evaluate(() => ({
      error: window.__film?.error ?? null,
      meta: window.__film?.meta ?? null,
    }));
    if (loaded.error) throw new Error(loaded.error);
    if (!loaded.meta) throw new Error("film timeline missing");
    const size = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      return {
        w: canvas?.width ?? 0,
        h: canvas?.height ?? 0,
        dpr: window.devicePixelRatio,
      };
    });
    if (size.w !== opts.width || size.h !== opts.height || size.dpr !== 1) {
      throw new Error(
        `canvas ${size.w}x${size.h} dpr ${size.dpr}, wanted ${opts.width}x${opts.height} dpr 1`,
      );
    }

    let fromMs = boundToMs(parseBound(opts.from), loaded.meta.firstTick);
    let toMs = boundToMs(parseBound(opts.to), loaded.meta.firstTick);
    if (fromMs < 0) fromMs = 0;
    if (toMs < 0) toMs = 0;
    const times = outputTimes(fromMs, toMs, opts.fps);
    let track:
      { t: number; pos: [number, number, number]; ease?: string }[] | null =
      null;
    if (opts.cameraPath) {
      const parsed = JSON.parse(await readText(opts.cameraPath)) as unknown;
      if (!Array.isArray(parsed))
        throw new Error("camera.json must be an array of keyframes");
      track = parsed as {
        t: number;
        pos: [number, number, number];
        ease?: string;
      }[];
      await page.evaluate((keys) => {
        window.__film?.setCamera(keys as never);
      }, track);
    }
    if (opts.lookahead !== false) {
      const cameraPoints = track
        ? sampleTrackPoints(track, fromMs / 1000, toMs / 1000)
        : [];
      await page.evaluate(
        (args) => {
          window.__film?.prepareLookahead?.(args);
        },
        {
          fromMs,
          toMs,
          cameraPoints,
          enabled: true,
        },
      );
    }

    await page.evaluate((ms) => window.__film?.applyThrough(ms), fromMs);
    await page.waitForFunction(
      () =>
        window.__film?.bootstrapped === true &&
        window.__viewer?.assetsSettled === true &&
        window.__viewer?.schemaOk === true,
      undefined,
      { timeout: 120_000 },
    );
    const note = await page.evaluate(() => window.__film?.assetNote ?? "");
    if (note && note !== "ready") {
      console.error(`film: packs not ready (${note}); placeholder terrain`);
    }
    const schemaError = await page.evaluate(
      () => window.__viewer?.lastError ?? null,
    );
    if (schemaError) throw new Error(schemaError);

    if (fromMs > 0) await page.clock.runFor(fromMs);
    await page.evaluate((ms) => window.__film?.setNow(ms), fromMs);
    let clock = fromMs;
    const renderer = await page.evaluate(
      () => window.__film?.renderer() ?? "unknown",
    );
    const t0 = performance.now();
    for (let i = 0; i < times.length; i++) {
      const target = times[i]!;
      const delta = target - clock;
      if (delta > 0) {
        await page.clock.runFor(delta);
        clock += delta;
      }
      await page.evaluate((ms) => window.__film?.setNow(ms), target);
      const png = await presentStable(page);
      const name = `frame_${String(i).padStart(5, "0")}.png`;
      writeFileSync(join(frameDir, name), Buffer.from(png, "base64"));
    }
    const seconds = (performance.now() - t0) / 1000;
    if (mp4) await encodeMp4(frameDir, mp4, opts.fps, opts.width, opts.height);
    console.error(
      `film: ${times.length} frames in ${seconds.toFixed(2)}s (${(times.length / seconds).toFixed(2)} fps) renderer=${renderer}`,
    );
    return {
      frames: times.length,
      width: opts.width,
      height: opts.height,
      seconds,
      fps: times.length / seconds,
      renderer,
      frameDir,
      mp4,
    };
  } finally {
    await browser?.close();
    await server.close();
  }
}

/**
 * Present until two reads match, so a pack fetch that lands between draws
 * cannot split a frame. The page clock does not move, so motion lerp stays put.
 *
 * @param page - Film page.
 * @returns PNG base64 of the settled frame.
 */
async function presentStable(page: Page): Promise<string> {
  // Model/texture fetches resolve after the keyframe that spawned the entity.
  // Capturing before they settle paints the wireframe placeholder.
  await page.waitForFunction(
    () => (window.__viewer?.pendingModelLoads ?? 0) === 0,
    undefined,
    { timeout: 120_000 },
  );
  let prev = "";
  for (let i = 0; i < 10; i++) {
    const png = await page.evaluate(() => window.__film?.present() ?? "");
    if (!png) throw new Error("film present returned empty");
    if (i > 0 && png === prev) return png;
    prev = png;
    await page.waitForTimeout(40);
  }
  console.error(
    "film: frame did not settle in 10 presents; using the last read",
  );
  return prev;
}

/**
 * @param gpu - Metal instead of SwiftShader.
 * @returns Chromium launch args.
 */
function chromiumArgs(gpu: boolean): string[] {
  const gl = gpu
    ? [
        "--use-gl=angle",
        "--use-angle=metal",
        "--ignore-gpu-blocklist",
        "--enable-gpu",
      ]
    : [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ];
  return [
    ...gl,
    "--force-device-scale-factor=1",
    "--force-color-profile=srgb",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ];
}

/**
 * @param frameDir - Directory of `frame_%05d.png` starting at 0.
 * @param mp4 - Output file.
 * @param fps - Constant playback rate.
 * @param width - Frame width (logged if padded for yuv420p).
 * @param height - Frame height.
 */
async function encodeMp4(
  frameDir: string,
  mp4: string,
  fps: number,
  width: number,
  height: number,
): Promise<void> {
  const bin = ffmpegBin();
  const args = [
    "-y",
    "-framerate",
    String(fps),
    "-start_number",
    "0",
    "-i",
    join(frameDir, "frame_%05d.png"),
  ];
  if (width % 2 !== 0 || height % 2 !== 0) {
    console.error(
      `film: ${width}x${height} is odd; yuv420p needs even size, padding by 1`,
    );
    args.push("-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2");
  }
  args.push(
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "16",
    "-an",
    "-movflags",
    "+faststart",
    mp4,
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}\n${err}`));
    });
  });
}

/** @returns an ffmpeg binary that answers `-version`. */
function ffmpegBin(): string {
  const candidates = [
    process.env.FFMPEG,
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
  ].filter((v): v is string => !!v);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["-version"], { stdio: "ignore" });
      return bin;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("ffmpeg not found (PATH or /opt/homebrew/bin/ffmpeg)");
}

/**
 * @param path - File path.
 * @returns UTF-8 contents.
 */
async function readText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
