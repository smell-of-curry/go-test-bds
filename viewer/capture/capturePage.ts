import { clearTimeout, setTimeout } from "node:timers";
import type { Page } from "playwright";

const FRAME_STALL_MS = 8_000;

class CaptureFrameStalledError extends Error {}

export type RecoveryReason = "page-crashed" | "frame-stalled";

/** Waits for a current world frame without interrupting a progressing viewer. */
export async function waitForCaptureFrame(
  page: Page,
  minTick: number,
  remainingMs: () => number,
  mayRecover: boolean,
): Promise<void> {
  const ready = (need: number): boolean => {
    const v = window.__viewer;
    return !!v && v.schemaOk && v.tick >= need && v.assetsSettled;
  };

  // Leave time for the original wait after the single reconnect. Only a
  // fully initialized viewer with a stale stream is eligible for a kick.
  let before: number | null = null;
  while (mayRecover && remainingMs() > 2 * FRAME_STALL_MS) {
    before ??= await withinCaptureDeadline(
      () => observedReadyTick(page, minTick),
      remainingMs,
    );
    try {
      await page.waitForFunction(ready, minTick, {
        timeout: Math.min(FRAME_STALL_MS, remainingMs()),
        polling: 250,
      });
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError")
        throw error;
    }
    const after = await withinCaptureDeadline(
      () => observedReadyTick(page, minTick),
      remainingMs,
    );
    if (before !== null && after === before && remainingMs() > FRAME_STALL_MS) {
      throw new CaptureFrameStalledError(
        `viewer world tick stalled at ${after} while waiting for ${minTick}`,
      );
    }
    before = after;
  }
  await page.waitForFunction(ready, minTick, {
    timeout: remainingMs(),
    polling: 250,
  });
}

function observedReadyTick(
  page: Page,
  minTick: number,
): Promise<number | null> {
  return page.evaluate((need) => {
    const v = window.__viewer;
    return v?.schemaOk &&
      v.assetsSettled &&
      typeof v.kick === "function" &&
      Number.isSafeInteger(v.tick) &&
      v.tick > 0 &&
      v.tick < need
      ? v.tick
      : null;
  }, minTick);
}

/** Retries one still within its wire deadline after a crash or a stale stream. */
export async function captureWithPageRecovery<Page>(
  page: Page,
  capture: (
    page: Page,
    remainingMs: () => number,
    mayRecover: boolean,
  ) => Promise<void>,
  recover: (failed: Page, reason: RecoveryReason) => Promise<Page | undefined>,
  deadline: number,
): Promise<void> {
  const remainingMs = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("capture deadline exceeded");
    return remaining;
  };

  try {
    remainingMs();
    await capture(page, remainingMs, true);
  } catch (error) {
    const stalled = error instanceof CaptureFrameStalledError;
    if (
      !stalled &&
      !/Target (crashed|page, context or browser has been closed)/i.test(
        String(error),
      )
    )
      throw error;

    const replacement = await withinCaptureDeadline(
      () => recover(page, stalled ? "frame-stalled" : "page-crashed"),
      remainingMs,
    );
    if (replacement === undefined || (!stalled && replacement === page))
      throw error;
    remainingMs();
    await capture(replacement, remainingMs, false);
  }
}

async function withinCaptureDeadline<T>(
  read: () => Promise<T>,
  remainingMs: () => number,
): Promise<T> {
  const timeout = remainingMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("capture deadline exceeded")),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
