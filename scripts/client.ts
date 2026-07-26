import { type Player, system, world } from "@minecraft/server";
import type {
  InstructionAction,
  InstructionParametersByAction,
} from "./__generated__/types";
import {
  decodeStatus,
  encodeInstruction,
  msToTicks,
  type StatusEnvelope,
} from "./protocol";

/** Default addon-side deadline for a single instruction, in milliseconds. */
export const DEFAULT_ACTION_TIMEOUT_MS = 20_000;

/** Options accepted by {@link runAction} and the higher-level bot helpers. */
export interface RunActionOptions {
  /**
   * How long to wait for the bot's status reply, in milliseconds. Also sent to
   * the bot so its own deadline matches. Defaults to
   * {@link DEFAULT_ACTION_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/**
 * Thrown when a bot reports that an instruction failed, or when it never
 * reports back at all.
 */
export class InstructionError extends Error {
  /** The action that failed. */
  readonly action: string;
  /** The status the bot reported, or `"timeout"` when it never replied. */
  readonly status: StatusEnvelope["status"];

  /**
   * @param action The action that failed.
   * @param status The reported status.
   * @param message Human-readable failure detail.
   */
  constructor(
    action: string,
    status: StatusEnvelope["status"],
    message: string,
  ) {
    super(`action "${action}" ${status}: ${message}`);
    this.name = "InstructionError";
    this.action = action;
    this.status = status;
  }
}

interface PendingRequest {
  botId: string;
  action: string;
  resolve(envelope: StatusEnvelope): void;
  reject(error: Error): void;
  timeoutHandle: number;
}

const pending = new Map<string, PendingRequest>();
let nextRequestId = 0;
let subscribed = false;

/**
 * Subscribes the single shared status listener.
 *
 * One listener serves every in-flight instruction: statuses are routed by
 * request id, so concurrent instructions cannot resolve each other's promises
 * (which is exactly what a listener-per-call would do).
 */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;

  world.beforeEvents.chatSend.subscribe((event) => {
    const envelope = decodeStatus(event.message);
    if (!envelope) return;

    // Keep bot bookkeeping out of the server's chat, and out of any chat
    // logging the host addon does on top of it.
    event.cancel = true;

    const request = envelope.id
      ? pending.get(envelope.id)
      : oldestRequestFor(event.sender.id);
    if (!request) return;
    if (request.botId !== event.sender.id) return;

    settle(envelope.id ?? idOf(request), envelope);
  });
}

/**
 * Finds the earliest still-pending request belonging to a bot. Used only when
 * talking to a bot old enough not to echo request ids.
 *
 * @param botId The entity id of the bot that reported a status.
 * @returns The oldest matching request, or `undefined` when none is pending.
 */
function oldestRequestFor(botId: string): PendingRequest | undefined {
  for (const request of pending.values()) {
    if (request.botId === botId) return request;
  }
  return undefined;
}

/**
 * Reverse-lookup of a request's id.
 *
 * @param request The pending request to find.
 * @returns The id the request is registered under, or an empty string.
 */
function idOf(request: PendingRequest): string {
  for (const [id, candidate] of pending) {
    if (candidate === request) return id;
  }
  return "";
}

/**
 * Resolves a pending request and clears its timeout.
 *
 * @param id The request id to settle.
 * @param envelope The status reported by the bot.
 */
function settle(id: string, envelope: StatusEnvelope): void {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  system.clearRun(request.timeoutHandle);
  request.resolve(envelope);
}

/**
 * Sends an instruction to a bot and waits for its status report.
 *
 * Prefer the typed helpers on {@link Bot}; this is the escape hatch for
 * actions the wrapper does not model yet.
 *
 * @param bot The bot player to drive.
 * @param action The action to run.
 * @param parameters Parameters for the action.
 * @param options Timeout overrides.
 * @returns The bot's status envelope, including any `data` payload.
 * @throws {InstructionError} if the bot reports a failure or never replies.
 */
export async function runAction<T extends InstructionAction, TData = unknown>(
  bot: Player,
  action: T,
  parameters: InstructionParametersByAction[T],
  options: RunActionOptions = {},
): Promise<StatusEnvelope<TData>> {
  ensureSubscribed();

  const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const id = `${++nextRequestId}`;
  const botId = bot.id;

  const result = new Promise<StatusEnvelope<TData>>((resolve, reject) => {
    // Give the bot a grace period past its own deadline so that a bot-side
    // timeout surfaces as the bot's own error message rather than ours.
    const timeoutHandle = system.runTimeout(
      () => {
        pending.delete(id);
        reject(
          new InstructionError(
            action,
            "timeout",
            `bot did not report a status within ${timeoutMs}ms`,
          ),
        );
      },
      msToTicks(timeoutMs) + 10,
    );

    pending.set(id, {
      botId,
      action,
      resolve: resolve as (envelope: StatusEnvelope) => void,
      reject,
      timeoutHandle,
    });
  });

  bot.sendMessage(encodeInstruction({ id, action, parameters, timeoutMs }));

  const envelope = await result;
  if (envelope.status !== "success") {
    throw new InstructionError(
      action,
      envelope.status,
      envelope.message ?? "no detail reported",
    );
  }
  return envelope;
}

/**
 * Runs an action and returns only its data payload.
 *
 * @param bot The bot player to drive.
 * @param action The action to run.
 * @param parameters Parameters for the action.
 * @param options Timeout overrides.
 * @returns The action's `data` payload.
 * @throws {InstructionError} if the bot reports a failure or never replies.
 */
export async function runActionForData<
  T extends InstructionAction,
  TData,
>(
  bot: Player,
  action: T,
  parameters: InstructionParametersByAction[T],
  options: RunActionOptions = {},
): Promise<TData> {
  const envelope = await runAction<T, TData>(
    bot,
    action,
    parameters,
    options,
  );
  return envelope.data as TData;
}

/**
 * Rejects every in-flight instruction. Call this when tearing a run down so a
 * disconnected bot cannot leave promises hanging until their deadline.
 *
 * @param reason Message attached to each rejection.
 */
export function cancelAllInstructions(reason = "run cancelled"): void {
  for (const [id, request] of [...pending]) {
    pending.delete(id);
    system.clearRun(request.timeoutHandle);
    request.reject(new InstructionError(request.action, "error", reason));
  }
}
