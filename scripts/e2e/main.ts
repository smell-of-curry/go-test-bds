/**
 * CI fixture pack entry. Bundled into testdata/e2e-pack/scripts/main.js.
 *
 * Arms a `gotestbds:run` script-event listener (same trigger path production
 * uses via bds-manager) and prints an unambiguous `GOTESTBDS_E2E_RESULT` line
 * when the run finishes so the workflow can grep BDS stdout.
 */

import { ScriptEventSource, system } from "@minecraft/server";
import {
  Bot,
  ConsoleReporter,
  MultiReporter,
  runSuites,
  StructuredReporter,
  type RunResult,
} from "../index";
import { BOT_NAME, protocolSuite } from "./suite";

/** Script event that starts a run. Matches pokebedrock-beh / bds-manager. */
const RUN_EVENT_ID = "gotestbds:run";

/** Body of the `gotestbds:run` script event. */
interface RunRequest {
  /** Correlates this run's reported events. */
  runId?: string;
  /** How many bots the suite needs. Defaults to 1. */
  bots?: number;
}

let running = false;

/**
 * Emits the single CI gate line.
 *
 * @param ok Whether every non-skipped test passed.
 */
function emitResultLine(ok: boolean): void {
  console.log(`GOTESTBDS_E2E_RESULT: ${ok ? "PASS" : "FAIL"}`);
}

/**
 * Waits for the expected bots to be online.
 *
 * @param count How many bots to wait for.
 * @returns The connected bots, in name order.
 */
async function connectBots(count: number): Promise<Bot[]> {
  const bots: Bot[] = [];
  for (let index = 0; index < count; index++) {
    const name = index === 0 ? BOT_NAME : `${BOT_NAME}${index + 1}`;
    console.log(`[tests] waiting for bot "${name}"`);
    bots.push(await Bot.waitForJoin(name, { timeoutMs: 90_000 }));
  }
  return bots;
}

/**
 * Parses a run request and executes the protocol suite.
 *
 * @param message The script event's message, expected to be JSON.
 * @returns A promise that settles once the run has been reported.
 */
async function startRun(message: string): Promise<void> {
  if (running) {
    console.warn("[tests] a run is already in progress; ignoring request");
    return;
  }

  let request: RunRequest = {};
  if (message.trim().length > 0) {
    try {
      request = JSON.parse(message) as RunRequest;
    } catch {
      console.error(`[tests] could not parse run request: ${message}`);
      emitResultLine(false);
      return;
    }
  }

  running = true;
  const runId = request.runId ?? `e2e-${Date.now()}`;
  try {
    const bots = await connectBots(request.bots ?? 1);
    const result: RunResult = await runSuites([protocolSuite], {
      bots,
      runId,
      defaultTestTimeoutMs: 60_000,
      reporter: new MultiReporter(
        new ConsoleReporter(),
        new StructuredReporter(),
      ),
    });
    const ok = result.totals.failed === 0 && result.totals.passed > 0;
    console.log(
      `[tests] run ${runId} complete: ${result.totals.passed} passed, ` +
        `${result.totals.failed} failed, ${result.totals.skipped} skipped`,
    );
    emitResultLine(ok);
  } catch (error) {
    console.error(
      `[tests] run ${runId} aborted: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
    emitResultLine(false);
  } finally {
    running = false;
  }
}

system.afterEvents.scriptEventReceive.subscribe(
  (event) => {
    if (event.sourceType !== ScriptEventSource.Server) return;
    if (event.id !== RUN_EVENT_ID) return;
    void startRun(event.message);
  },
  { namespaces: ["gotestbds"] },
);

console.log(
  `[tests] go-test-bds e2e fixture armed; send "scriptevent ${RUN_EVENT_ID}" to start`,
);
