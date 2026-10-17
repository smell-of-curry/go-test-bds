/**
 * Serve GET /font/{name} from GOTESTBDS_VIEWER_FONT_DIR.
 * Unset directory or a missing file is 404 so specs fall back to system UI.
 */
import { existsSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

/**
 * @param pathname - Request path (`/font/Mojangles.ttf`).
 * @param res - Response. Returns true when the path was a font route.
 * @returns true if this request was handled.
 */
export function handleFontFile(pathname: string, res: ServerResponse): boolean {
  if (!pathname.startsWith("/font/")) return false;
  const dir = process.env.GOTESTBDS_VIEWER_FONT_DIR ?? "";
  const name = decodeURIComponent(pathname.slice("/font/".length));
  const bad =
    !name || name.includes("/") || name.includes("\\") || name.includes("..");
  if (!dir || bad) {
    res.writeHead(!dir || !name ? 404 : 400, {
      "Access-Control-Allow-Origin": "*",
    });
    res.end();
    return true;
  }
  const file = join(dir, name);
  if (!existsSync(file)) {
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    res.end();
    return true;
  }
  res.writeHead(200, {
    "Content-Type": "font/ttf",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(readFileSync(file));
  return true;
}
