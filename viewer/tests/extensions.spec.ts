/**
 * Node-only tests for the viewer extension loader (no browser).
 */
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";

import {
  loadViewerExtensions,
  mergeViewerExtensions,
} from "../src/extensions/load";
import type { ViewerExtensionModule } from "../src/extensions/types";

test("mergeViewerExtensions keeps builtins unless a module opts out", () => {
  const extra: ViewerExtensionModule = {
    onBind(ctx) {
      ctx.props.marked = true;
    },
  };
  const merged = mergeViewerExtensions([extra]);
  expect(merged?.replaceBuiltins).toBe(false);

  const replacing: ViewerExtensionModule = { replaceBuiltins: true };
  expect(mergeViewerExtensions([extra, replacing])?.replaceBuiltins).toBe(true);
  expect(mergeViewerExtensions([])).toBeNull();
});

test("loadViewerExtensions reads manifest modules and ignores a missing hub", async () => {
  const empty = await loadViewerExtensions("http://127.0.0.1:1", {
    fetch: async () => {
      throw new Error("offline");
    },
  });
  expect(empty.hud).toBeNull();

  const server = await listen((req, res) => {
    const path = req.url ?? "/";
    if (path === "/viewer.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ v: 1, extensions: "/extensions/" }));
      return;
    }
    if (path === "/extensions/manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ modules: ["./overlay.mjs"] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const imported: string[] = [];
  const loaded = await loadViewerExtensions(server.url, {
    importModule: async (url) => {
      imported.push(url);
      const mod: ViewerExtensionModule = {
        replaceBuiltins: true,
        preloadTextures: ["textures/ui/example"],
        resolveTitle: (input) => `t:${input.tokens.sidebar ?? ""}`,
      };
      return { viewerExtension: mod as unknown as Record<string, unknown> };
    },
  });
  await server.close();

  expect(imported.some((u) => u.endsWith("/extensions/overlay.mjs"))).toBe(
    true,
  );
  expect(loaded.hud?.replaceBuiltins).toBe(true);
  expect(loaded.hud?.preloadTextures).toEqual(["textures/ui/example"]);
  expect(
    loaded.hud?.resolveTitle?.({
      title: "",
      subtitle: "",
      actionBar: "",
      tokens: { sidebar: "x" },
    }),
  ).toBe("t:x");
});

/**
 * @param handler - Request handler.
 * @returns base URL and close.
 */
function listen(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((done, reject) => {
            server.close((err) => (err ? reject(err) : done()));
          }),
      });
    });
  });
}
