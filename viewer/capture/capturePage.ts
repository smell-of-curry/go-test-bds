import { clearTimeout, setTimeout } from "node:timers";

/** Retries one still on a replacement Chromium page within its wire deadline. */
export async function captureWithPageRecovery<Page>(
  page: Page,
  capture: (page: Page, remainingMs: () => number) => Promise<void>,
  recover: (failed: Page) => Promise<Page | undefined>,
  deadline: number,
): Promise<void> {
  const remainingMs = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("capture deadline exceeded");
    return remaining;
  };

  try {
    remainingMs();
    await capture(page, remainingMs);
  } catch (error) {
    if (
      !/Target (crashed|page, context or browser has been closed)/i.test(
        String(error),
      )
    ) {
      throw error;
    }

    let timer: ReturnType<typeof setTimeout> | number | undefined;
    try {
      const timeout = remainingMs();
      const replacement = await Promise.race([
        recover(page),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(resolve, timeout);
        }),
      ]);
      if (replacement === undefined || replacement === page) throw error;
      remainingMs();
      await capture(replacement, remainingMs);
    } finally {
      clearTimeout(timer);
    }
  }
}
