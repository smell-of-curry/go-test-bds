/**
 * Ensure the pinned bedrock-samples extract exists at `<repo>/.cache/baseline`.
 * World and PHUD goldens are recorded with real vanilla textures; a wiped
 * cache silently degrades renders to solid fixtures and fails goldens with
 * confusing diffs, so fetch it back instead.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const viewerRoot = join(here, "..");
const repoRoot = join(viewerRoot, "..");

/**
 * Fetch the pinned baseline via `go run ./cmd/fetch-baseline` when missing.
 * No-op when already extracted, when `GOLDEN_USE_BASELINE=0`, or when the
 * fetch fails (tests then fail with golden diffs as before).
 *
 * @returns absolute baseline dir, or null when unavailable.
 */
export function ensureBaseline(): string | null {
  if (process.env.GOLDEN_USE_BASELINE === "0") return null;
  const tag = readFileSync(join(viewerRoot, "baseline.tag"), "utf8").trim();
  const pinned = tag.startsWith("v") ? tag : `v${tag}`;
  const dir = join(repoRoot, ".cache", "baseline", pinned);
  if (existsSync(join(dir, "resource_pack", "blocks.json"))) return dir;
  try {
    execSync("go run ./cmd/fetch-baseline .cache", {
      cwd: repoRoot,
      stdio: "inherit",
      timeout: 300_000,
    });
  } catch (err) {
    console.warn(`[ensureBaseline] fetch failed: ${String(err)}`);
    return null;
  }
  return existsSync(join(dir, "resource_pack", "blocks.json")) ? dir : null;
}
