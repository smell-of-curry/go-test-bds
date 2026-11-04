import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";
import { build } from "vite";
import { fileURLToPath } from "node:url";
import { writeGoldenMotionTake } from "./fixture-take";
import { encodeMp4, filmFrameDirectory, renderFilm } from "./render";
import { boundToMs, outputTimes, parseBound } from "./time";
import { sampleFilmCamera } from "../src/camera";

const viewerRoot = fileURLToPath(new URL("..", import.meta.url));
const appDir = join(viewerRoot, "dist-film-app");

test("time bounds and 60 fps grid", () => {
  assert.deepEqual(parseBound("1.5"), { kind: "sec", value: 1.5 });
  assert.deepEqual(parseBound("30t"), { kind: "tick", value: 30 });
  assert.equal(boundToMs(parseBound("100t"), 100), 0);
  assert.equal(boundToMs(parseBound("101t"), 100), 50);
  assert.equal(boundToMs(parseBound("0.5s"), 0), 500);
  const times = outputTimes(0, Math.round((10 / 60) * 1000), 60);
  assert.equal(times.length, 10);
  assert.equal(times[0], 0);
  assert.equal(times[1], 17);
});

test("film camera eases yaw the short way", () => {
  const mid = sampleFilmCamera(
    [
      { t: 0, pos: [0, 0, 0], yaw: 170, pitch: 0, fov: 70, ease: "linear" },
      { t: 1, pos: [0, 0, 0], yaw: -170, pitch: 0, fov: 70, ease: "linear" },
    ],
    0.5,
  );
  assert.ok(Math.abs(mid.yaw - 180) < 1e-6 || Math.abs(mid.yaw + 180) < 1e-6);
  const eased = sampleFilmCamera(
    [
      { t: 0, pos: [0, 0, 0], yaw: 0, pitch: 0, fov: 70 },
      { t: 1, pos: [2, 0, 0], yaw: 0, pitch: 0, fov: 70, ease: "inOutSine" },
    ],
    0.5,
  );
  assert.ok(Math.abs(eased.pos[0] - 1) < 1e-6);
});

test(
  "film render is byte-stable and time advances",
  { timeout: 300_000 },
  async () => {
    await build({
      root: viewerRoot,
      configFile: join(viewerRoot, "vite.config.ts"),
      logLevel: "error",
      build: { outDir: appDir, emptyOutDir: true },
    });
    const take = mkdtempSync(join(tmpdir(), "film-take-"));
    const outA = mkdtempSync(join(tmpdir(), "film-a-"));
    const outB = mkdtempSync(join(tmpdir(), "film-b-"));
    try {
      const bot = writeGoldenMotionTake(take);
      const common = {
        takeDir: take,
        bot,
        from: "0",
        to: "0.1666667",
        width: 320,
        height: 180,
        fps: 60,
        cameraPath: join(take, "camera.json"),
        appDir,
        gpu: false,
      };
      const a = await renderFilm({ ...common, out: outA });
      const b = await renderFilm({ ...common, out: outB });
      assert.equal(a.frames, 10);
      assert.equal(b.frames, 10);
      assert.match(a.renderer, /SwiftShader/i);
      const names = readdirSync(outA)
        .filter((n) => n.endsWith(".png"))
        .sort();
      assert.deepEqual(
        names,
        readdirSync(outB)
          .filter((n) => n.endsWith(".png"))
          .sort(),
      );
      assert.equal(names.length, 10);
      const bufs = names.map((n) => readFileSync(join(outA, n)));
      let differed = false;
      for (let i = 0; i < names.length; i++) {
        const got = bufs[i]!;
        const other = readFileSync(join(outB, names[i]!));
        assert.ok(
          got.equals(other),
          `${names[i]} is not byte-identical across runs`,
        );
        const png = PNG.sync.read(got);
        assert.equal(png.width, 320, names[i]);
        assert.equal(png.height, 180, names[i]);
        if (i > 0 && !got.equals(bufs[i - 1]!)) differed = true;
      }
      assert.ok(
        differed,
        "consecutive frames are identical; virtual time did not advance",
      );
    } finally {
      rmSync(take, { recursive: true, force: true });
      rmSync(outA, { recursive: true, force: true });
      rmSync(outB, { recursive: true, force: true });
    }
  },
);

test("film encoder caps a reused 222-frame directory to the 150 freshly rendered frames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "film-encode-count-"));
  try {
    const png = new PNG({ width: 16, height: 16 });
    png.data.fill(255);
    const image = PNG.sync.write(png);
    for (let i = 0; i < 222; i++) {
      writeFileSync(
        join(dir, `frame_${String(i).padStart(5, "0")}.png`),
        image,
      );
    }
    const out = join(dir, "clip.mp4");
    const count = () =>
      Number(
        execFileSync(
          process.env.FFPROBE ?? "ffprobe",
          [
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "csv=p=0",
            out,
          ],
          { encoding: "utf8" },
        ).trim(),
      );
    await encodeMp4(dir, out, 60, 16, 16, 222);
    assert.equal(count(), 222);
    // A shorter re-render overwrites its first 150 PNGs but leaves the old tail.
    for (let i = 0; i < 150; i++) {
      writeFileSync(
        join(dir, `frame_${String(i).padStart(5, "0")}.png`),
        image,
      );
    }
    await encodeMp4(dir, out, 60, 16, 16, 150);
    assert.equal(count(), 150);
    assert.equal(
      readdirSync(dir).filter((name) => name.endsWith(".png")).length,
      222,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("film segment PNG directories are named after their output", () => {
  assert.equal(
    filmFrameDirectory("/takes/clips/catch-seg0.mp4"),
    "/takes/clips/catch-seg0-frames",
  );
  assert.equal(
    filmFrameDirectory("/takes/clips/catch-seg1.mp4"),
    "/takes/clips/catch-seg1-frames",
  );
  assert.equal(filmFrameDirectory("/takes/raw-frames"), "/takes/raw-frames");
});
