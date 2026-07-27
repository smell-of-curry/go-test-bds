import { expect, test } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import {
  createPushableStream,
  loadJsonlFrames,
  type JsonlFrame,
} from "./fixtureServer";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const cliPath = join(viewerRoot, "dist-capture", "cli.cjs");

interface UploadedArtifact {
  kind: string;
  ext: string;
  bot: string;
  captureId?: string;
  tick?: number;
  width?: string;
  height?: string;
  durationMs?: string;
  runId?: string;
  suite?: string;
  test?: string;
  label?: string;
  bytes: number;
  body: Buffer;
}

interface CaptureError {
  id: string;
  message: string;
}

interface FakeBot {
  url: string;
  stream: ReturnType<typeof createPushableStream>;
  artifacts: UploadedArtifact[];
  errors: CaptureError[];
  waitForArtifact: (
    pred: (a: UploadedArtifact) => boolean,
  ) => Promise<UploadedArtifact>;
  close: () => Promise<void>;
}

/**
 * Await until `pred` is true, polling on a short interval.
 *
 * @param pred - Condition to satisfy.
 * @param timeoutMs - Max wait.
 * @returns resolves when pred is true.
 * @throws on timeout.
 */
async function waitFor(pred: () => boolean, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function buildCaptureCli(): Promise<void> {
  await build({
    entryPoints: [join(viewerRoot, "capture", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: cliPath,
    external: ["playwright"],
    logLevel: "silent",
  });
}

async function startFakeBot(): Promise<FakeBot> {
  const all = loadJsonlFrames();
  const hello = all.find((f) => f.type === "hello");
  const keyframe = all.find((f) => f.type === "keyframe");
  if (!hello || !keyframe) throw new Error("testdata missing hello/keyframe");

  const stream = createPushableStream([hello, keyframe]);
  const artifacts: UploadedArtifact[] = [];
  const errors: CaptureError[] = [];
  const waiters: Array<{
    pred: (a: UploadedArtifact) => boolean;
    resolve: (a: UploadedArtifact) => void;
  }> = [];

  const vite: ViteDevServer = await createViteServer({
    root: viewerRoot,
    configFile: join(viewerRoot, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "spa",
  });

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/stream") {
      stream.handle(req, res);
      return;
    }

    if (url.pathname === "/bots") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          v: 1,
          bots: [
            {
              name: "TestBot",
              tick: 100,
              dimension: 0,
              attached: stream.attached,
            },
          ],
        }),
      );
      return;
    }

    if (url.pathname === "/artifact" && req.method === "POST") {
      const body = await readBody(req);
      const art: UploadedArtifact = {
        kind: String(req.headers["x-artifact-kind"] ?? ""),
        ext: String(req.headers["x-artifact-ext"] ?? ""),
        bot: String(req.headers["x-artifact-bot"] ?? ""),
        captureId: header(req, "x-capture-id"),
        tick: header(req, "x-artifact-tick")
          ? Number(header(req, "x-artifact-tick"))
          : undefined,
        width: header(req, "x-artifact-width"),
        height: header(req, "x-artifact-height"),
        durationMs: header(req, "x-artifact-duration-ms"),
        runId: header(req, "x-artifact-run"),
        suite: header(req, "x-artifact-suite"),
        test: header(req, "x-artifact-test"),
        label: header(req, "x-artifact-label"),
        bytes: body.length,
        body,
      };
      artifacts.push(art);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!;
        if (w.pred(art)) {
          waiters.splice(i, 1);
          w.resolve(art);
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          v: 1,
          path: `${art.suite ?? "x"}/${art.test ?? "y"}/${art.label ?? "z"}.${art.ext}`,
          bytes: body.length,
        }),
      );
      return;
    }

    const errMatch = /^\/capture\/([^/]+)\/error$/.exec(url.pathname);
    if (errMatch && req.method === "POST") {
      const raw = await readBody(req);
      let message = "";
      try {
        message = String(
          (JSON.parse(raw.toString("utf8")) as { message?: string }).message ??
            "",
        );
      } catch {
        message = raw.toString("utf8");
      }
      errors.push({ id: decodeURIComponent(errMatch[1]!), message });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ v: 1, ok: true }));
      return;
    }

    vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("not found");
    });
  }

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no bind address");
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    stream,
    artifacts,
    errors,
    waitForArtifact(pred) {
      const existing = artifacts.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        waiters.push({ pred, resolve });
      });
    },
    close: () =>
      new Promise((resolve, reject) => {
        stream.closeAll();
        server.close((err) => {
          void vite.close().then(() => (err ? reject(err) : resolve()), reject);
        });
      }),
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function mark(phase: string, extra: Partial<JsonlFrame> = {}): JsonlFrame {
  return {
    v: 1,
    type: "mark",
    bot: "TestBot",
    tick: 100,
    phase,
    ...extra,
  };
}

function delta(tick: number): JsonlFrame {
  return {
    v: 1,
    type: "delta",
    bot: "TestBot",
    tick,
    actor: {
      rid: 1,
      uid: 1,
      name: "TestBot",
      pos: [8.5, 65, 8.5],
      eyePos: [8.5, 66.62, 8.5],
      rot: [180, 20],
      vel: [0, 0, 0],
      onGround: true,
      gamemode: 0,
      dimension: 0,
      health: 20,
      maxHealth: 20,
      food: 20,
      heldSlot: 0,
      sneaking: false,
      sprinting: false,
      swimming: false,
      gliding: false,
      hotbar: Array(9).fill(null),
      inventory: Array(36).fill(null),
      offhand: null,
      armour: [null, null, null, null],
      effects: [],
      chunkRadius: 4,
    },
  };
}

function spawnHarness(stream: string): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      cliPath,
      "--stream",
      stream,
      "--bot",
      "TestBot",
      "--width",
      "640",
      "--height",
      "360",
      "--max-segment-seconds",
      "60",
      "--log-level",
      "info",
    ],
    {
      cwd: viewerRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  );
}

test("capture harness: stills + one run video against fake bot", async () => {
  await buildCaptureCli();

  const bot = await startFakeBot();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawnHarness(bot.url);

    const exitPromise = new Promise<number>((resolve, reject) => {
      child!.on("error", reject);
      child!.on("exit", (code, signal) => {
        if (signal) reject(new Error(`harness killed by ${signal}`));
        else resolve(code ?? 1);
      });
    });

    // Node SSE + stills page EventSource (harness connects SSE before page).
    // One context records video on that same page — no extra EventSource.
    await waitFor(() => bot.stream.attached >= 2);

    bot.stream.broadcast(
      mark("runStart", { runId: "run-cap", suite: "", test: "" }),
    );
    bot.stream.broadcast(
      mark("testStart", {
        runId: "run-cap",
        suite: "machines",
        test: "places a crate",
        tick: 100,
      }),
    );

    bot.stream.broadcast(delta(110));
    bot.stream.broadcast(delta(120));
    bot.stream.broadcast({
      v: 1,
      type: "capture",
      bot: "TestBot",
      id: "cap-3",
      minTick: 120,
      ext: "png",
      label: "after-interact",
    });

    const capPng = await bot.waitForArtifact(
      (a) => a.kind === "screenshot" && a.captureId === "cap-3",
    );
    expect(capPng.ext).toBe("png");
    expect(capPng.bot).toBe("TestBot");
    expect(capPng.tick).toBeGreaterThanOrEqual(120);
    expect(capPng.bytes).toBeGreaterThan(1_000);
    expect(capPng.runId).toBe("run-cap");
    expect(capPng.suite).toBe("machines");
    expect(capPng.test).toBe("places a crate");
    expect(capPng.width).toBe("640");
    expect(capPng.height).toBe("360");
    expect(capPng.body.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

    bot.stream.broadcast(
      mark("testEnd", {
        runId: "run-cap",
        suite: "machines",
        test: "places a crate",
        status: "passed",
        message: "ok",
        tick: 120,
      }),
    );

    // passed testEnd must NOT upload video or a failure still
    expect(bot.artifacts.some((a) => a.kind === "video")).toBe(false);
    expect(
      bot.artifacts.some(
        (a) =>
          a.kind === "screenshot" &&
          a.label === "failure" &&
          a.test === "places a crate",
      ),
    ).toBe(false);

    const attachedAfterPass = bot.stream.attached;
    bot.stream.broadcast(
      mark("testStart", {
        runId: "run-cap",
        suite: "machines",
        test: "opens the lid",
        tick: 120,
      }),
    );
    // Same long-lived page — attachment count must not grow for video.
    await new Promise((r) => setTimeout(r, 500));
    expect(bot.stream.attached).toBe(attachedAfterPass);

    bot.stream.broadcast(delta(130));
    bot.stream.broadcast(
      mark("testEnd", {
        runId: "run-cap",
        suite: "machines",
        test: "opens the lid",
        status: "failed",
        message: "expected open, got shut",
        tick: 130,
      }),
    );

    const failStill = await bot.waitForArtifact(
      (a) =>
        a.kind === "screenshot" &&
        a.label === "failure" &&
        a.test === "opens the lid",
    );
    expect(failStill.ext).toBe("png");
    expect(failStill.bot).toBe("TestBot");
    expect(failStill.runId).toBe("run-cap");
    expect(failStill.bytes).toBeGreaterThan(1_000);
    // Still no video until the stream closes.
    expect(bot.artifacts.filter((a) => a.kind === "video")).toHaveLength(0);

    bot.stream.broadcast(
      mark("runEnd", {
        runId: "run-cap",
        status: "failed",
        tick: 130,
      }),
    );
    bot.stream.closeAll();

    const runVideo = await bot.waitForArtifact((a) => a.kind === "video");
    expect(runVideo.ext).toBe("webm");
    expect(runVideo.bot).toBe("TestBot");
    expect(runVideo.durationMs).toBeTruthy();
    expect(runVideo.bytes).toBeGreaterThan(100);
    expect(runVideo.runId).toBe("run-cap");
    expect(runVideo.label).toBe("run");
    expect(bot.artifacts.filter((a) => a.kind === "video")).toHaveLength(1);

    for (const a of bot.artifacts) {
      expect(a.kind === "screenshot" || a.kind === "video").toBe(true);
      expect(a.ext === "png" || a.ext === "webm").toBe(true);
      expect(a.bot).toBe("TestBot");
    }

    const code = await exitPromise;
    expect(code).toBe(0);
    expect(bot.errors).toEqual([]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await bot.close();
  }
});
