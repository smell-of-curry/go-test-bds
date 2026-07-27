import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export interface FixtureServer {
  url: string;
  streamUrl: string;
  close: () => Promise<void>;
}

export type JsonlFrame = { type: string; [key: string]: unknown };

/**
 * Load a JSONL fixture (one frame object per non-empty line).
 *
 * @param jsonlPath - Absolute path to the fixture file.
 * @returns parsed frame objects in file order.
 */
export function loadJsonlFrames(
  jsonlPath = join(here, "..", "testdata", "basic.jsonl"),
): JsonlFrame[] {
  return readFileSync(jsonlPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as JsonlFrame);
}

/**
 * Write one SSE event for a frame.
 *
 * @param res - Open SSE response.
 * @param frame - Frame object (its `type` becomes the event name).
 */
export function writeSseFrame(res: ServerResponse, frame: JsonlFrame): void {
  const type = typeof frame.type === "string" ? frame.type : "message";
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

export interface PushableStream {
  /** Live SSE subscriber count (browser + harness Node clients). */
  readonly attached: number;
  /**
   * Replace the bootstrap frames sent to every new subscriber (hello + keyframe).
   *
   * @param frames - Frames replayed at the start of each connection.
   */
  setBootstrap: (frames: JsonlFrame[]) => void;
  /**
   * Attach an HTTP request as an SSE subscriber.
   *
   * @param req - Incoming request (for close cleanup).
   * @param res - Response upgraded to `text/event-stream`.
   */
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  /**
   * Broadcast a frame to every live subscriber.
   *
   * @param frame - Frame to emit.
   */
  broadcast: (frame: JsonlFrame) => void;
  /** End every live subscriber (clean stream close). */
  closeAll: () => void;
}

/**
 * Controllable SSE hub: each subscriber gets bootstrap, then live broadcasts.
 *
 * @param bootstrap - Initial hello + keyframe (updated via `setBootstrap`).
 * @returns pushable stream handle.
 */
export function createPushableStream(
  bootstrap: JsonlFrame[] = [],
): PushableStream {
  let boot = bootstrap.slice();
  const live = new Set<ServerResponse>();

  return {
    get attached() {
      return live.size;
    },
    setBootstrap(frames) {
      boot = frames.slice();
    },
    handle(req, res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      for (const frame of boot) writeSseFrame(res, frame);
      live.add(res);
      const keepalive = setInterval(() => {
        res.write(": keepalive\n\n");
      }, 15_000);
      const cleanup = () => {
        clearInterval(keepalive);
        live.delete(res);
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
    },
    broadcast(frame) {
      if (frame.type === "keyframe") {
        const hello = boot.find((f) => f.type === "hello");
        boot = hello ? [hello, frame] : [frame];
      }
      for (const res of live) writeSseFrame(res, frame);
    },
    closeAll() {
      for (const res of live) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
      live.clear();
    },
  };
}

/**
 * Tiny SSE server that replays `testdata/basic.jsonl` once per connection.
 * Used only by the Playwright smoke test so the app hits a real EventSource.
 *
 * @param jsonlPath - Absolute path to a JSONL fixture (one frame per line).
 * @returns bound server info.
 */
export async function startFixtureServer(
  jsonlPath = join(here, "..", "testdata", "basic.jsonl"),
): Promise<FixtureServer> {
  const frames = loadJsonlFrames(jsonlPath);
  const stream = createPushableStream(frames);

  // Smoke test wants the full fixture once, then an idle keepalive — not a
  // live broadcast hub. Replay the whole file as bootstrap and never broadcast.
  stream.setBootstrap(frames);

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ v: 1, ok: true }));
      return;
    }
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
    url: base,
    streamUrl: `${base}/stream?bot=TestBot`,
    close: () =>
      new Promise((resolve, reject) => {
        stream.closeAll();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
