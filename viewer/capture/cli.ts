import { existsSync } from "node:fs";
import {
  requestHarnessShutdown,
  runHarness,
  type HarnessOptions,
  type LogLevel,
} from "./harness";

const HELP = `Usage: node viewer/dist-capture/cli.cjs --stream <url> --bot <name> [options]

Headless capture harness for the go-test-bds viewer stream.
Opens <stream>/?bot=<bot>, records one run video + stills, POSTs to /artifact.

Options:
  --stream <url>                 Bot viewer base URL (required)
  --bot <name>                   Bot name (required)
  --width <n>                    Viewport width (default 1280)
  --height <n>                   Viewport height (default 720)
  --max-segment-seconds <n>      Cap run recording length (default 120)
  --browser <path>               Chromium executable path
  --video-out <file>             Write the run video here instead of POSTing it
  --log-level <level>            debug | info | warn | error (default info)
  --help                         Show this help
`;

interface ParsedArgs {
  help: boolean;
  options: {
    stream?: string;
    bot?: string;
    width?: number;
    height?: number;
    maxSegmentSeconds?: number;
    browser?: string;
    videoOut?: string;
    logLevel?: LogLevel;
  };
}

/**
 * Parse argv flags for the capture CLI.
 *
 * @param argv - Arguments after `node …/cli.cjs`.
 * @returns parsed flags (may be incomplete; caller validates).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const options: ParsedArgs["options"] = {
    width: 1280,
    height: 720,
    maxSegmentSeconds: 120,
    logLevel: "info",
  };
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--stream") {
      options.stream = next();
      continue;
    }
    if (a === "--bot") {
      options.bot = next();
      continue;
    }
    if (a === "--width") {
      options.width = Number(next());
      continue;
    }
    if (a === "--height") {
      options.height = Number(next());
      continue;
    }
    if (a === "--max-segment-seconds") {
      options.maxSegmentSeconds = Number(next());
      continue;
    }
    if (a === "--browser") {
      options.browser = next();
      continue;
    }
    if (a === "--video-out") {
      options.videoOut = next();
      continue;
    }
    if (a === "--log-level") {
      options.logLevel = next() as LogLevel;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }

  return { help, options };
}

/**
 * Resolve a Chromium binary path, or `null` if none exists.
 *
 * Precedence: `--browser`, `PLAYWRIGHT_CHROMIUM`, `CHROME_PATH`, Playwright bundle.
 *
 * @param flag - Optional `--browser` path.
 * @returns absolute executable path, or null.
 */
export function resolveBrowser(flag?: string): string | null {
  const candidates = [
    flag,
    process.env.PLAYWRIGHT_CHROMIUM,
    process.env.CHROME_PATH,
  ].filter((p): p is string => !!p && p.length > 0);

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  try {
    // Lazy require so --help works even if playwright is missing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require("playwright") as typeof import("playwright");
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    /* playwright not installed */
  }
  return null;
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }

  const { stream, bot } = parsed.options;
  if (!stream || !bot) {
    console.error("missing required --stream and/or --bot\n");
    process.stdout.write(HELP);
    process.exitCode = 1;
    return;
  }

  const browserPath = resolveBrowser(parsed.options.browser);
  if (!browserPath) {
    console.error(
      "capture: no Chromium found (--browser, PLAYWRIGHT_CHROMIUM, CHROME_PATH, or Playwright bundle)",
    );
    process.exitCode = 1;
    return;
  }

  const opts: HarnessOptions = {
    stream: stream.replace(/\/+$/, ""),
    bot,
    width: parsed.options.width ?? 1280,
    height: parsed.options.height ?? 720,
    maxSegmentSeconds: parsed.options.maxSegmentSeconds ?? 120,
    browserPath,
    logLevel: parsed.options.logLevel ?? "info",
    ...(parsed.options.videoOut ? { videoOut: parsed.options.videoOut } : {}),
  };

  // Registered before the harness starts: the runner can terminate this process
  // at any point, and without a listener the default action kills it outright,
  // which loses the recording. With one, shutdown always runs the normal path.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      console.warn(`capture: ${signal} received; finishing the run video`);
      requestHarnessShutdown();
    });
  }

  try {
    await runHarness(opts);
  } catch (err) {
    // Start-up failures only — runHarness swallows mid-run errors.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

void main();
