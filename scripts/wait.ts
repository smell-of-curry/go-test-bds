import { system, TicksPerSecond } from "@minecraft/server";
import { msToTicks } from "./protocol";

/** Options for {@link waitFor}. */
export interface WaitOptions {
  /** Give up after this many milliseconds. Defaults to 10 000. */
  timeoutMs?: number;
  /** Delay between polls, in milliseconds. Defaults to 250. */
  intervalMs?: number;
  /**
   * What is being waited for, used in the timeout message. Always set this —
   * "condition not met" tells whoever reads the CI log nothing.
   */
  description?: string;
}

/** Thrown when a {@link waitFor} condition does not become true in time. */
export class TimeoutError extends Error {
  /**
   * @param description What was being waited for.
   * @param timeoutMs How long was waited before giving up.
   */
  constructor(description: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for ${description}`);
    this.name = "TimeoutError";
  }
}

/**
 * Suspends for a number of milliseconds, rounded up to whole ticks.
 *
 * @param ms How long to sleep.
 * @returns A promise resolving once the delay has elapsed.
 */
export async function sleep(ms: number): Promise<void> {
  await system.waitTicks(msToTicks(ms));
}

/**
 * Polls a condition until it is true.
 *
 * This is the primitive every "wait for the game to catch up" step in a test
 * should use, rather than sleeping for a guessed duration: it returns as soon
 * as the condition holds, so a fast server is not punished, and it fails with a
 * useful message when the condition never holds.
 *
 * @param condition Predicate to poll. May be async. Exceptions propagate, so
 * guard against handles that can go invalid mid-run.
 * @param options Timeout, poll interval and description.
 * @returns A promise resolving once the condition is true.
 * @throws {TimeoutError} if the condition is still false at the deadline.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: WaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 250;
  const description = options.description ?? "condition";

  const deadlineTick = system.currentTick + msToTicks(timeoutMs);
  for (;;) {
    if (await condition()) return;
    if (system.currentTick >= deadlineTick) {
      throw new TimeoutError(description, timeoutMs);
    }
    await system.waitTicks(msToTicks(intervalMs));
  }
}

/**
 * Polls until a getter returns a value that is neither `undefined` nor `null`.
 *
 * @param getter Called each poll; its first defined result is returned.
 * @param options Timeout, poll interval and description.
 * @returns The first defined value the getter produced.
 * @throws {TimeoutError} if the getter never produced a defined value.
 */
export async function waitForValue<T>(
  getter: () => T | undefined | null | Promise<T | undefined | null>,
  options: WaitOptions = {},
): Promise<T> {
  let captured: T | undefined;
  await waitFor(
    async () => {
      const value = await getter();
      if (value === undefined || value === null) return false;
      captured = value;
      return true;
    },
    options,
  );
  return captured as T;
}

/**
 * Retries an operation until it completes without throwing.
 *
 * Useful for steps that are legitimately flaky against a live server — a click
 * that lands a tick before the target entity is tracked, for instance — but not
 * a substitute for waiting on the right condition.
 *
 * @param operation The operation to attempt.
 * @param options Timeout, delay between attempts and description.
 * @returns The operation's result.
 * @throws the last error thrown by the operation once the deadline passes.
 */
export async function retry<T>(
  operation: () => T | Promise<T>,
  options: WaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadlineTick = system.currentTick + msToTicks(timeoutMs);

  let lastError: unknown;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (system.currentTick >= deadlineTick) break;
      await system.waitTicks(msToTicks(intervalMs));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError));
}

/**
 * Converts seconds to milliseconds, for readability at call sites where a bare
 * millisecond count would need a comment.
 *
 * @param value A duration in seconds.
 * @returns The duration in milliseconds.
 */
export function seconds(value: number): number {
  return value * 1000;
}

/**
 * Converts Minecraft ticks to milliseconds.
 *
 * @param value A duration in ticks.
 * @returns The duration in milliseconds.
 */
export function ticks(value: number): number {
  return (value / TicksPerSecond) * 1000;
}
