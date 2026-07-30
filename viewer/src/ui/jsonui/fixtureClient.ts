/**
 * Filesystem-backed {@link UiLoadClient} for tests (testdata/jsonui).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseLooseJson, type UiLoadClient, type UiPackInfo } from "./load";

/**
 * Build a stub client that serves `testdata/jsonui/{vanilla,pokebedrock}/…`
 * as packs with ids `vanilla` (priority 0) and `pokebedrock` (priority 1).
 *
 * Fixture files live without the `ui/` prefix at the pack root of each folder
 * (e.g. `vanilla/hud_screen.json` ↔ pack path `ui/hud_screen.json`).
 *
 * @param fixturesRoot - Absolute path to `testdata/jsonui`.
 * @returns injectable load client.
 */
export function createFixtureUiClient(fixturesRoot: string): UiLoadClient {
  const packs: UiPackInfo[] = [
    { id: "vanilla", priority: 0 },
    { id: "pokebedrock", priority: 1 },
  ];

  return {
    async getPacks() {
      return packs;
    },
    async fetchPackJson<T = unknown>(
      packId: string,
      path: string,
    ): Promise<T | null> {
      const rel = path.replace(/^ui\//i, "");
      const abs = join(fixturesRoot, packId, rel);
      if (!existsSync(abs) || !statSync(abs).isFile()) return null;
      try {
        return parseLooseJson<T>(
          readFileSync(abs, "utf8"),
          `${packId}:${path}`,
        );
      } catch {
        return null;
      }
    },
  };
}

/**
 * List fixture files under a pack dir (debug).
 *
 * @param dir - Pack fixture directory.
 * @returns relative paths.
 */
export function listFixtureFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out;
}
