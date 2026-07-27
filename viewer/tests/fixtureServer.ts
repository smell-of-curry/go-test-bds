import { createServer, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export interface FixtureServer {
  url: string;
  streamUrl: string;
  close: () => Promise<void>;
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
  const lines = readFileSync(jsonlPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const live = new Set<ServerResponse>();

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

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    for (const line of lines) {
      let type = "message";
      try {
        type = (JSON.parse(line) as { type: string }).type;
      } catch {
        /* keep default */
      }
      res.write(`event: ${type}\n`);
      res.write(`data: ${line}\n\n`);
    }

    // Keep the SSE socket open for the life of the test. Ending it makes
    // EventSource reconnect and paints a spurious "stream error" on the HUD.
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
        for (const res of live) {
          try {
            res.end();
          } catch {
            /* already closed */
          }
        }
        live.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
