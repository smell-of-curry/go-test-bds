import { type Player, TicksPerSecond } from "@minecraft/server";
import type {
  InstructionAction,
  InstructionParametersByAction,
} from "./__generated__/types";
import { TemporaryCallback } from "./utils/temporaryCallback";

interface InstructionStatus {
  status: "success" | "error";
  message?: string;
}

/**
 * Sends an instruction to a player.
 * @param player - The player to send the instruction to.
 * @param action - The action to send.
 * @param parameters - The parameters to send.
 */
function sendInstructionToBot<T extends InstructionAction>(
  bot: Player,
  action: T,
  parameters: InstructionParametersByAction[T],
  timeout: number = TicksPerSecond * 20,
): Promise<InstructionStatus> {
  const promise = new Promise<InstructionStatus>((resolve, reject) => {
    TemporaryCallback.subscribe(
      "beforeEvents",
      "chatSend",
      (remove, data) => {
        if (!data.message.startsWith("[STATUS]")) return;
        if (data.sender.id != bot.id) return;
        remove();

        // Cancel the message so it doesn't get sent to the server
        data.cancel = true;

        try {
          // Parse the status message
          const ctx: InstructionStatus = JSON.parse(
            data.message.replace(/^\[STATUS\]/, ""),
          );
          if (ctx.status === "success") resolve(ctx);
          else reject(ctx);
        } catch (error) {
          console.error("Error parsing status message", error);
          reject(error);
        }
      },
      undefined,
      timeout,
      (expired) => {
        if (!expired) return;
        reject(new Error("Action timed out"));
      },
    );
  });

  bot.sendMessage(
    `[RUN_ACTION]${JSON.stringify({
      action,
      parameters,
    })}`,
  );

  return promise;
}

/**
 * Runs an action on a bot.
 * @param bot - The bot to run the action on.
 * @param action - The action to run.
 * @param parameters - The parameters to run the action with.
 * @param timeout - The timeout for the action.
 * @returns True if the action was successful, false otherwise.
 * @throws An error if the action fails.
 */
export async function runAction<T extends InstructionAction>(
  bot: Player,
  action: T,
  parameters: InstructionParametersByAction[T],
  timeout: number = TicksPerSecond * 20,
): Promise<boolean> {
  const res = await sendInstructionToBot(bot, action, parameters, timeout);
  if (res.status == "success") return true;

  throw new Error(
    `Failed to run action: ${action}, status: ${res.status}, message: ${res.message}`,
  );
}
