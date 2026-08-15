// Frame montage for eyeballing a run video: crops the diagnostic overlay out of
// evenly spaced frames and stacks them into one image, so the text stays legible
// at a size worth looking at. Playwright is already here; ffmpeg's bundled build
// has no tile filter.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { chromium } from "playwright";

const [video, outPrefix, countArg] = process.argv.slice(2);
if (!video || !outPrefix) {
  console.error("usage: node montage.mjs <video> <out-prefix> [frames]");
  process.exit(1);
}
const count = Number(countArg ?? 12);
const ff = process.env.FFMPEG ?? "ffmpeg";

function duration(path) {
  try {
    execFileSync(ff, ["-hide_banner", "-i", path], { stdio: "pipe" });
  } catch (err) {
    const text = String(err.stderr ?? "");
    const m = text.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return 0;
}

const dur = duration(video);
if (!dur) {
  console.error(`could not read duration of ${video}`);
  process.exit(1);
}

const work = resolve(`${outPrefix}-frames`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

for (let i = 0; i < count; i++) {
  const t = (dur * (i + 0.5)) / count;
  const n = String(i).padStart(2, "0");
  execFileSync(ff, [
    "-y", "-loglevel", "error", "-ss", t.toFixed(3), "-i", video,
    "-frames:v", "1", join(work, `full-${n}.png`),
  ]);
  execFileSync(ff, [
    "-y", "-loglevel", "error", "-ss", t.toFixed(3), "-i", video,
    "-frames:v", "1", "-vf", "crop=560:184:0:0", join(work, `hud-${n}.png`),
  ]);
}

const files = readdirSync(work);
const hud = files.filter((f) => f.startsWith("hud-")).sort();
const full = files.filter((f) => f.startsWith("full-")).sort();

const browser = await chromium.launch();

async function grid(list, columns, width, out, label) {
  // Data URIs, not file:// — a page served from about:blank cannot read local files.
  const cells = list
    .map((f, i) => {
      const b64 = readFileSync(join(work, f)).toString("base64");
      return (
        `<figure><figcaption>${label} ${i}</figcaption>` +
        `<img src="data:image/png;base64,${b64}" width="${width}"></figure>`
      );
    })
    .join("");
  const page = await browser.newPage({
    viewport: { width: columns * (width + 8) + 8, height: 600 },
  });
  await page.setContent(
    `<style>body{margin:4px;background:#111;display:grid;` +
      `grid-template-columns:repeat(${columns},${width}px);gap:4px;font:12px monospace;color:#8f8}` +
      `figure{margin:0}figcaption{padding:1px 3px}img{display:block}</style>${cells}`,
  );
  await page.waitForLoadState("load");
  await page.screenshot({ path: out, fullPage: true });
  await page.close();
  console.log(`${out} (${list.length} frames from ${basename(video)}, ${dur.toFixed(2)}s)`);
}

await grid(hud, 2, 560, `${outPrefix}-hud.png`, "t");
await grid(full, 3, 420, `${outPrefix}-world.png`, "t");
await browser.close();
