import { TicksPerSecond } from "@minecraft/server";
import type {
  InstructionAction,
  InstructionParametersByAction,
} from "./__generated__/types";

/**
 * Prefix of a message sent from the addon to a bot asking it to perform an
 * action. Must match `DefaultInstructionPrefix` in the Go runner.
 */
export const INSTRUCTION_PREFIX = "[RUN_ACTION]";

/**
 * Prefix of the chat message a bot sends back to report the outcome of an
 * action. Must match `StatusMessagePrefix` in the Go runner.
 */
export const STATUS_PREFIX = "[STATUS]";

/**
 * Prefix of one fragment of a chunked status message. Large envelopes (e.g. a
 * form snapshot with dozens of buttons) exceed the chat length BDS accepts,
 * so the bot splits them into `[STATUSPART]<id>:<index>/<total>:<fragment>`
 * messages with a 1-based index. Must match `StatusPartPrefix` in the Go
 * runner.
 */
export const STATUS_PART_PREFIX = "[STATUSPART]";

/** One fragment of a chunked status envelope. */
export interface StatusPart {
  /** Instruction id the fragment belongs to. */
  id: string;
  /** 1-based fragment index. */
  index: number;
  /** Total number of fragments in the envelope. */
  total: number;
  /** Raw JSON fragment to concatenate. */
  fragment: string;
}

/** Outcome of a single instruction, as reported by the bot. */
export type InstructionStatusKind = "success" | "error" | "timeout";

/**
 * Envelope sent from the addon to a bot.
 *
 * `id` correlates the request with its {@link StatusEnvelope}. It is optional
 * on the wire for backwards compatibility, but this SDK always sends one so
 * that concurrent instructions cannot resolve each other's promises.
 */
export interface InstructionEnvelope<
  T extends InstructionAction = InstructionAction,
> {
  id: string;
  action: T;
  parameters: InstructionParametersByAction[T];
  /** Bot-side deadline in milliseconds. Omitted to use the bot's default. */
  timeoutMs?: number;
}

/** Envelope sent from a bot back to the addon once an instruction settles. */
export interface StatusEnvelope<TData = unknown> {
  /** Echoed from the request. Absent when talking to a pre-v2 bot. */
  id?: string;
  status: InstructionStatusKind;
  /** Failure detail. Empty or absent on success. */
  message?: string;
  /** Payload produced by observation instructions. */
  data?: TData;
}

/**
 * Converts a duration in milliseconds to whole Minecraft ticks, rounding up so
 * that a sub-tick duration still waits at least one tick.
 *
 * @param ms Duration in milliseconds.
 * @returns The equivalent number of ticks, at least 1.
 */
export function msToTicks(ms: number): number {
  return Math.max(1, Math.ceil((ms * TicksPerSecond) / 1000));
}

/**
 * Builds the chat payload that asks a bot to run an action.
 *
 * @param envelope The instruction to encode.
 * @returns The string to pass to `Player.sendMessage`.
 */
export function encodeInstruction(envelope: InstructionEnvelope): string {
  return INSTRUCTION_PREFIX + JSON.stringify(envelope);
}

/**
 * Parses a bot's status message.
 *
 * @param message The raw chat message, including the `[STATUS]` prefix.
 * @returns The decoded envelope, or `undefined` when the message is not a
 * status report or is not valid JSON.
 */
export function decodeStatus<TData = unknown>(
  message: string,
): StatusEnvelope<TData> | undefined {
  if (!message.startsWith(STATUS_PREFIX)) return undefined;
  try {
    return JSON.parse(
      message.slice(STATUS_PREFIX.length),
    ) as StatusEnvelope<TData>;
  } catch {
    return undefined;
  }
}

/**
 * Parses one fragment of a chunked status message.
 *
 * @param message The raw chat message, including the `[STATUSPART]` prefix.
 * @returns The decoded part, or `undefined` when the message is not a status
 * fragment or its header is malformed.
 */
export function decodeStatusPart(message: string): StatusPart | undefined {
  if (!message.startsWith(STATUS_PART_PREFIX)) return undefined;
  const rest = message.slice(STATUS_PART_PREFIX.length);
  const match = /^([^:]+):(\d+)\/(\d+):/.exec(rest);
  if (!match) return undefined;
  const index = Number(match[2]);
  const total = Number(match[3]);
  if (index < 1 || total < 1 || index > total) return undefined;
  return {
    id: match[1] ?? "",
    index,
    total,
    fragment: rest.slice(match[0].length),
  };
}
