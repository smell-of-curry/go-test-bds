import type { Dimension, Vector3 } from "@minecraft/server";
import { waitFor, type WaitOptions } from "./wait";

/** Thrown by every assertion in this module when it does not hold. */
export class AssertionError extends Error {
  /**
   * @param message What was expected, and what was actually observed.
   */
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/**
 * Formats a value for an assertion message, keeping objects readable but short.
 *
 * @param value The value to describe.
 * @returns A short printable form of the value.
 */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Asserts that a condition holds.
 *
 * @param condition The condition to check.
 * @param message Description of what should have been true.
 * @throws {AssertionError} if the condition is falsy.
 */
export function assert(condition: unknown, message: string): void {
  if (condition) return;
  throw new AssertionError(message);
}

/**
 * Asserts strict equality.
 *
 * @param actual The observed value.
 * @param expected The value that was expected.
 * @param message Optional context prefixed to the failure.
 * @throws {AssertionError} if the values are not strictly equal.
 */
export function assertEquals<T>(
  actual: T,
  expected: T,
  message?: string,
): void {
  if (actual === expected) return;
  const detail = `expected ${describe(expected)} but got ${describe(actual)}`;
  throw new AssertionError(message ? `${message}: ${detail}` : detail);
}

/**
 * Asserts that a value is neither `undefined` nor `null`, narrowing its type.
 *
 * @param value The value to check.
 * @param message Description of what should have been present.
 * @throws {AssertionError} if the value is `undefined` or `null`.
 */
export function assertDefined<T>(
  value: T | undefined | null,
  message: string,
): asserts value is T {
  if (value !== undefined && value !== null) return;
  throw new AssertionError(`${message} (was ${describe(value)})`);
}

/**
 * Asserts that a string contains a substring, ignoring case.
 *
 * @param actual The string to search.
 * @param needle The substring that must be present.
 * @param message Optional context prefixed to the failure.
 * @throws {AssertionError} if the substring is absent.
 */
export function assertContains(
  actual: string,
  needle: string,
  message?: string,
): void {
  if (actual.toLowerCase().includes(needle.toLowerCase())) return;
  const detail = `expected ${describe(actual)} to contain ${describe(needle)}`;
  throw new AssertionError(message ? `${message}: ${detail}` : detail);
}

/**
 * Asserts that a number falls within an inclusive range. Use this instead of
 * {@link assertEquals} for anything the engine may nudge, such as a position
 * after a teleport.
 *
 * @param actual The observed value.
 * @param min Lowest acceptable value.
 * @param max Highest acceptable value.
 * @param message Optional context prefixed to the failure.
 * @throws {AssertionError} if the value falls outside the range.
 */
export function assertInRange(
  actual: number,
  min: number,
  max: number,
  message?: string,
): void {
  if (actual >= min && actual <= max) return;
  const detail = `expected a value in [${min}, ${max}] but got ${actual}`;
  throw new AssertionError(message ? `${message}: ${detail}` : detail);
}

/**
 * Asserts that two positions are within a tolerance of each other.
 *
 * @param actual The observed position.
 * @param expected The intended position.
 * @param tolerance Maximum acceptable distance on each axis, in blocks.
 * @param message Optional context prefixed to the failure.
 * @throws {AssertionError} if any axis differs by more than the tolerance.
 */
export function assertNearPosition(
  actual: Vector3,
  expected: Vector3,
  tolerance = 1,
  message?: string,
): void {
  const off = {
    x: Math.abs(actual.x - expected.x),
    y: Math.abs(actual.y - expected.y),
    z: Math.abs(actual.z - expected.z),
  };
  if (off.x <= tolerance && off.y <= tolerance && off.z <= tolerance) return;
  const detail =
    `expected a position within ${tolerance} of ` +
    `${describe(expected)} but got ${describe(actual)}`;
  throw new AssertionError(message ? `${message}: ${detail}` : detail);
}

/**
 * Asserts the block type at a location, as the server sees it.
 *
 * @param dimension The dimension to read.
 * @param location The block location to read.
 * @param expectedTypeId The block type id that should be present.
 * @param message Optional context prefixed to the failure.
 * @throws {AssertionError} if the block is absent, unloaded, or a different
 * type.
 */
export function assertBlockAt(
  dimension: Dimension,
  location: Vector3,
  expectedTypeId: string,
  message?: string,
): void {
  const block = dimension.getBlock(location);
  const detail = `at ${describe(location)}`;
  assertDefined(block, message ? `${message}: no block ${detail}` : `no block ${detail}`);
  assertEquals(
    block.typeId,
    expectedTypeId,
    message ? `${message}: wrong block ${detail}` : `wrong block ${detail}`,
  );
}

/**
 * Waits for a condition and fails as an assertion rather than a timeout, so the
 * report reads as "the game never reached this state" instead of "something
 * timed out".
 *
 * @param condition Predicate to poll.
 * @param options Timeout, poll interval and description. Set `description`.
 * @returns A promise resolving once the condition holds.
 * @throws {AssertionError} if the condition never holds before the deadline.
 */
export async function assertEventually(
  condition: () => boolean | Promise<boolean>,
  options: WaitOptions = {},
): Promise<void> {
  try {
    await waitFor(condition, options);
  } catch {
    throw new AssertionError(
      `${options.description ?? "condition"} never became true within ` +
        `${options.timeoutMs ?? 10_000}ms`,
    );
  }
}

/**
 * Asserts that an operation throws.
 *
 * @param operation The operation expected to fail.
 * @param message Description of the failure that was expected.
 * @returns The error the operation threw.
 * @throws {AssertionError} if the operation completed successfully.
 */
export async function assertThrows(
  operation: () => unknown,
  message: string,
): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new AssertionError(`expected ${message} to throw, but it did not`);
}
