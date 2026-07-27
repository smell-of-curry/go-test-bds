import { expect, test, type Page } from "@playwright/test";
import { createServer as createHttpServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import {
  createPushableStream,
  loadJsonlFrames,
  type JsonlFrame,
} from "./fixtureServer";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const goStreamPath = join(
  viewerRoot,
  "..",
  "gotestbds",
  "viewer",
  "testdata",
  "go-stream.jsonl",
);

const frames = loadJsonlFrames(goStreamPath);
const lastTick = frames.reduce((max, f) => {
  const t = typeof f.tick === "number" ? f.tick : max;
  return t > max ? t : max;
}, 0);

interface PushableFixture {
  streamUrl: string;
  readonly attached: number;
  pushAll: (next: JsonlFrame[]) => void;
  close: () => Promise<void>;
}

/**
 * Await until `pred` is true, polling on a short interval.
 *
 * @param pred - Condition to satisfy.
 * @param timeoutMs - Max wait.
 * @throws on timeout.
 */
async function waitFor(pred: () => boolean, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * SSE stub with empty bootstrap so the test can observe startup before frames.
 *
 * @returns pushable fixture handle.
 */
async function startPushableFixture(): Promise<PushableFixture> {
  const stream = createPushableStream([]);
  const server: Server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/stream") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    stream.handle(req, res);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no bind address");
  const base = `http://127.0.0.1:${addr.port}`;

  return {
    streamUrl: `${base}/stream?bot=TestBot`,
    get attached() {
      return stream.attached;
    },
    pushAll(next) {
      for (const frame of next) stream.broadcast(frame);
    },
    close: () =>
      new Promise((resolve, reject) => {
        stream.closeAll();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Wait until the app has accepted the stream and reached the fixture's last tick.
 *
 * @param page - Playwright page with the viewer loaded.
 * @param needFrames - Expected `framesReceived` count.
 * @returns readiness snapshot used in assertions.
 */
async function waitForGoStreamReady(
  page: Page,
  needFrames: number,
): Promise<{
  schemaOk: boolean;
  tick: number;
  framesReceived: number;
  lastError: string | null;
  columnCount: number;
}> {
  await page.waitForFunction(
    ({ needTick, needFrames: n }) => {
      const v = window.__viewer;
      return !!v && v.schemaOk && v.tick >= needTick && v.framesReceived >= n;
    },
    { needTick: lastTick, needFrames },
    { timeout: 30_000 },
  );

  return page.evaluate(() => {
    const v = window.__viewer!;
    return {
      schemaOk: v.schemaOk,
      tick: v.tick,
      framesReceived: v.framesReceived,
      lastError: v.lastError,
      columnCount: v.columnCount,
    };
  });
}

test("viewer consumes Go golden stream: schemaOk + last tick", async ({
  page,
}) => {
  expect(frames.length).toBeGreaterThan(0);
  expect(frames[0]?.type).toBe("keyframe");

  const fixture = await startPushableFixture();
  let devServer: ViteDevServer | undefined;
  try {
    devServer = await createServer({
      root: viewerRoot,
      configFile: join(viewerRoot, "vite.config.ts"),
      server: { host: "127.0.0.1", port: 5175, strictPort: false },
    });
    await devServer.listen();
    const base = devServer.resolvedUrls?.local[0];
    if (!base) throw new Error("vite dev server has no local URL");

    const appUrl = `${base}?stream=${encodeURIComponent(fixture.streamUrl)}`;
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(() => !!window.__viewer);
    await waitFor(() => fixture.attached >= 1);

    // Empty bootstrap: handle exists, but no frame has made the app ready yet.
    const before = await page.evaluate(() => {
      const v = window.__viewer!;
      return {
        schemaOk: v.schemaOk,
        framesReceived: v.framesReceived,
        tick: v.tick,
      };
    });
    expect(before.schemaOk).toBe(false);
    expect(before.framesReceived).toBe(0);
    expect(before.tick).toBe(0);

    fixture.pushAll(frames);

    const got = await waitForGoStreamReady(page, frames.length);

    expect(got.schemaOk).toBe(true);
    expect(got.tick).toBe(lastTick);
    expect(got.framesReceived).toBe(frames.length);
    expect(got.lastError).toBeNull();
    expect(got.columnCount).toBeGreaterThan(0);
  } finally {
    await page.close().catch(() => undefined);
    await devServer?.close();
    await fixture.close();
  }
});
