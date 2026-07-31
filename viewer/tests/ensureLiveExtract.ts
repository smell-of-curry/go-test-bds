/**
 * Ensure `testdata/jsonui/live-v2.18.5/_extract` exists (gitignored).
 * Phone flipbook / PHUD chrome textures are served from that tree.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const zipPath = join(viewerRoot, "testdata/jsonui/live-v2.18.5.zip");
const destRoot = join(viewerRoot, "testdata/jsonui/live-v2.18.5");
const extractRoot = join(destRoot, "_extract");
/** Sentinel texture required by phone flipbook / PHUD chrome tests. */
const sentinel = join(extractRoot, "textures/ui/phud/oak_loop.png");

/**
 * Extract the live pack zip when the gitignored `_extract` tree is missing.
 *
 * @returns absolute path to `_extract`.
 * @throws if the zip is missing or extract fails to produce the sentinel.
 */
export function ensureLiveExtract(): string {
  if (existsSync(sentinel)) return extractRoot;
  if (!existsSync(zipPath)) {
    throw new Error(
      `live pack extract missing and zip not found:\n` +
        `  expected sentinel: ${sentinel}\n` +
        `  expected zip: ${zipPath}\n` +
        `Re-fetch testdata/jsonui/live-v2.18.5.zip or run extract manually.`,
    );
  }
  mkdirSync(destRoot, { recursive: true });
  if (existsSync(extractRoot)) {
    rmSync(extractRoot, { recursive: true, force: true });
  }
  mkdirSync(extractRoot, { recursive: true });
  execSync(`tar -xf "${zipPath}" -C "${extractRoot}"`, {
    stdio: "inherit",
  });
  if (!existsSync(sentinel)) {
    throw new Error(
      `live pack extract finished but sentinel missing: ${sentinel}`,
    );
  }
  return extractRoot;
}

/**
 * Soft check for tests that can skip when extract/zip are both absent.
 *
 * @returns true when oak_loop (or extractable zip) is available.
 */
export function liveExtractAvailable(): boolean {
  return existsSync(sentinel) || existsSync(zipPath);
}
