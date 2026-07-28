/**
 * One-origin app for golden shots: Vite + full fixture SSE + textured pack.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { createPushableStream, loadJsonlFrames } from "./fixtureServer";
import {
  buildFixturePack,
  solidPng,
  startTerrainAssetServer,
} from "./terrainAssetServer";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");

export interface GoldenApp {
  url: string;
  streamUrl: string;
  close: () => Promise<void>;
}

/**
 * Fixture pack plus netherrack so the final nether wall is atlas-textured.
 *
 * @returns pack file map.
 */
export function buildGoldenPack(): Map<string, Uint8Array> {
  const files = buildFixturePack();
  const json = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

  const blocks = JSON.parse(
    new TextDecoder().decode(files.get("blocks.json")!),
  ) as Record<string, unknown>;
  blocks["minecraft:netherrack"] = { textures: "netherrack" };
  files.set("blocks.json", json(blocks));

  const terrain = JSON.parse(
    new TextDecoder().decode(files.get("textures/terrain_texture.json")!),
  ) as {
    texture_data: Record<string, unknown>;
  };
  terrain.texture_data.netherrack = {
    textures: "textures/blocks/netherrack",
  };
  files.set("textures/terrain_texture.json", json(terrain));
  files.set("textures/blocks/netherrack.png", solidPng(16, 16, 160, 55, 45));
  return files;
}

/**
 * Serve the viewer, full basic.jsonl stream, and golden pack on one origin.
 *
 * @returns app URL handles.
 */
export async function startGoldenApp(): Promise<GoldenApp> {
  const frames = loadJsonlFrames();
  const stream = createPushableStream(frames);
  stream.setBootstrap(frames);

  const assets = await startTerrainAssetServer(buildGoldenPack());
  const vite: ViteDevServer = await createViteServer({
    root: viewerRoot,
    configFile: join(viewerRoot, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "spa",
  });

  const server: Server = createHttpServer((req, res) => {
    void handle(req, res);
  });

  async function proxyAsset(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const target = `${assets.url}${req.url ?? "/"}`;
    const upstream = await fetch(target);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(buf);
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/stream") {
      stream.handle(req, res);
      return;
    }
    if (
      url.pathname === "/packs" ||
      url.pathname === "/packs/index" ||
      url.pathname.startsWith("/pack/") ||
      url.pathname.startsWith("/asset/")
    ) {
      await proxyAsset(req, res);
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
    streamUrl: `${url}/stream?bot=TestBot`,
    close: () =>
      new Promise((resolve, reject) => {
        stream.closeAll();
        server.close((err) => {
          void Promise.all([vite.close(), assets.close()]).then(
            () => (err ? reject(err) : resolve()),
            reject,
          );
        });
      }),
  };
}
