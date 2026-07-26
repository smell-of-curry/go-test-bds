import { type Player, type Vector3, world } from "@minecraft/server";
import {
  runAction,
  runActionForData,
  type RunActionOptions,
} from "./client";
import type {
  BlockAtPosition,
  BotInventory,
  BotState,
  ClickedFormButton,
  Face,
  NearbyEntities,
  NearbyEntity,
  OpenForm,
  Pos,
  ReceivedMessages,
  Vec3,
} from "./types";
import { waitForValue, type WaitOptions } from "./wait";

/**
 * A headless test client, wrapped around the {@link Player} the server sees.
 *
 * Every method here drives the real client over the network, so an action that
 * the server would reject for a human player is rejected for a bot too — which
 * is the point: it exercises the same code paths a player does.
 */
export class Bot {
  /** The player handle the server has for this bot. */
  readonly player: Player;

  private readonly defaults: RunActionOptions;

  /**
   * @param player The bot's player handle.
   * @param defaults Default options applied to every action, e.g. a longer
   * timeout for a slow server.
   */
  constructor(player: Player, defaults: RunActionOptions = {}) {
    this.player = player;
    this.defaults = defaults;
  }

  /** The bot's in-game name. */
  get name(): string {
    return this.player.name;
  }

  /**
   * Merges per-call options over this bot's defaults.
   *
   * @param options Per-call overrides.
   * @returns The effective options.
   */
  private opts(options?: RunActionOptions): RunActionOptions {
    return { ...this.defaults, ...options };
  }

  /**
   * Waits for a bot with the given name to be online, then wraps it.
   *
   * @param name Exact player name the bot connects with.
   * @param options Timeout and poll interval for the wait.
   * @returns The connected bot.
   * @throws {TimeoutError} if no such player joins before the deadline.
   */
  static async waitForJoin(
    name: string,
    options: WaitOptions = {},
  ): Promise<Bot> {
    const player = await waitForValue(
      () => world.getAllPlayers().find((p) => p.name === name),
      {
        timeoutMs: 60_000,
        description: `bot "${name}" to join`,
        ...options,
      },
    );
    return new Bot(player);
  }

  /**
   * Returns the bot for a name if it is already online.
   *
   * @param name Exact player name.
   * @returns The bot, or `undefined` when it is not connected.
   */
  static find(name: string): Bot | undefined {
    const player = world.getAllPlayers().find((p) => p.name === name);
    return player ? new Bot(player) : undefined;
  }

  /** Whether the bot's player handle is still valid (i.e. still connected). */
  get isConnected(): boolean {
    return this.player.isValid;
  }

  // --- actions -------------------------------------------------------------

  /**
   * Sends a chat message as the bot.
   *
   * @param message The message to send.
   * @param options Timeout overrides.
   * @returns A promise resolving once the bot confirms the action.
   */
  async chat(message: string, options?: RunActionOptions): Promise<void> {
    await runAction(this.player, "chat", { message }, this.opts(options));
  }

  /**
   * Runs a slash command as the bot. The server applies the bot's own
   * permissions, so this fails for commands the bot may not run.
   *
   * @param command The command, without a leading slash.
   * @param options Timeout overrides.
   * @returns A promise resolving once the bot confirms the action.
   */
  async runCommand(
    command: string,
    options?: RunActionOptions,
  ): Promise<void> {
    await runAction(
      this.player,
      "runCommand",
      { command },
      this.opts(options),
    );
  }

  /**
   * Makes the bot jump once.
   *
   * @param options Timeout overrides.
   * @returns A promise resolving once the bot confirms the action.
   */
  async jump(options?: RunActionOptions): Promise<void> {
    await runAction(this.player, "jump", {}, this.opts(options));
  }

  /**
   * Turns the bot to face a location.
   *
   * @param position The location to look at.
   * @param options Timeout overrides.
   * @returns A promise resolving once the bot confirms the action.
   */
  async lookAt(position: Vector3, options?: RunActionOptions): Promise<void> {
    await runAction(
      this.player,
      "lookAtLocation",
      { location: [position.x, position.y, position.z] },
      this.opts(options),
    );
  }

  /**
   * Walks the bot to a block, pathfinding around obstacles.
   *
   * Navigation is the slowest thing a bot does; give it a generous timeout on
   * a busy server rather than lowering it and getting flaky failures.
   *
   * @param position The block to walk to.
   * @param options Timeout overrides. Defaults to 60s for this action.
   * @returns A promise resolving once the bot arrives.
   */
  async navigateTo(
    position: Vector3,
    options?: RunActionOptions,
  ): Promise<void> {
    await runAction(
      this.player,
      "navigateToBlock",
      { pos: toPos(position) },
      { timeoutMs: 60_000, ...this.opts(options) },
    );
  }

  /**
   * Interacts with (right-clicks) a block using whatever the bot is holding.
   *
   * @param position The block to interact with.
   * @param options Timeout overrides, plus which face was clicked and where on
   * that face. Defaults to the centre of the top face, which is what a player
   * standing over a block hits.
   * @returns A promise resolving once the bot confirms the action.
   */
  async interactWithBlock(
    position: Vector3,
    options?: RunActionOptions & { face?: Face; clickPos?: Vec3 },
  ): Promise<void> {
    await runAction(
      this.player,
      "interactWithBlock",
      {
        pos: toPos(position),
        face: options?.face ?? 1,
        clickPos: options?.clickPos ?? [0.5, 1, 0.5],
      },
      this.opts(options),
    );
  }

  /**
   * Breaks a block, waiting out its break time.
   *
   * @param position The block to break.
   * @param options Timeout overrides. Defaults to 60s for this action.
   * @returns A promise resolving once the block is broken.
   */
  async breakBlock(
    position: Vector3,
    options?: RunActionOptions,
  ): Promise<void> {
    await runAction(
      this.player,
      "breakBlock",
      { pos: toPos(position) },
      { timeoutMs: 60_000, ...this.opts(options) },
    );
  }

  /**
   * Selects a hotbar slot.
   *
   * @param slot Zero-based hotbar slot index.
   * @param options Timeout overrides.
   * @returns A promise resolving once the bot confirms the action.
   */
  async setHeldSlot(
    slot: number,
    options?: RunActionOptions,
  ): Promise<void> {
    await runAction(
      this.player,
      "setHeldSlot",
      { slot },
      this.opts(options),
    );
  }

  /**
   * Disconnects the bot from the server.
   *
   * @param options Timeout overrides.
   * @returns A promise resolving once the bot confirms the action.
   */
  async disconnect(options?: RunActionOptions): Promise<void> {
    await runAction(this.player, "disconnect", {}, this.opts(options));
  }

  // --- observation ---------------------------------------------------------

  /**
   * Reads the bot's own view of itself. Compare this against what the server
   * believes to catch desyncs — a bot that thinks it never moved while the
   * server teleported it is a real class of bug.
   *
   * @param options Timeout overrides.
   * @returns The bot's current state.
   */
  async getState(options?: RunActionOptions): Promise<BotState> {
    return runActionForData<"getState", BotState>(
      this.player,
      "getState",
      {},
      this.opts(options),
    );
  }

  /**
   * Reads the bot's inventory as the client sees it.
   *
   * @param options Timeout overrides.
   * @returns The bot's inventory.
   */
  async getInventory(options?: RunActionOptions): Promise<BotInventory> {
    return runActionForData<"getInventory", BotInventory>(
      this.player,
      "getInventory",
      {},
      this.opts(options),
    );
  }

  /**
   * Reads the form the bot currently has open without responding to it.
   *
   * @param options Timeout overrides.
   * @returns The open form, or `null` when the bot has no form open.
   */
  async getForm(options?: RunActionOptions): Promise<OpenForm | null> {
    return runActionForData<"getForm", OpenForm | null>(
      this.player,
      "getForm",
      {},
      this.opts(options),
    );
  }

  /**
   * Reads a block from the bot's own tracked world, i.e. what the client was
   * actually sent.
   *
   * @param position The block to read.
   * @param options Timeout overrides.
   * @returns The block at that position.
   * @throws {InstructionError} if the bot has not loaded that chunk.
   */
  async getBlock(
    position: Vector3,
    options?: RunActionOptions,
  ): Promise<BlockAtPosition> {
    return runActionForData<"getBlock", BlockAtPosition>(
      this.player,
      "getBlock",
      { pos: toPos(position) },
      this.opts(options),
    );
  }

  /**
   * Lists entities the bot can see, nearest first.
   *
   * @param radius Search radius in blocks. Defaults to the bot's own default.
   * @param options Timeout overrides.
   * @returns The visible entities, sorted by ascending distance.
   */
  async getNearbyEntities(
    radius?: number,
    options?: RunActionOptions,
  ): Promise<NearbyEntity[]> {
    const data = await runActionForData<"getNearbyEntities", NearbyEntities>(
      this.player,
      "getNearbyEntities",
      { radius: radius ?? 0 },
      this.opts(options),
    );
    return data.entities;
  }

  /**
   * Reads the messages the bot has received recently.
   *
   * @param limit Maximum number of messages, newest last.
   * @param options Timeout overrides.
   * @returns The received messages.
   */
  async getMessages(
    limit = 50,
    options?: RunActionOptions,
  ): Promise<ReceivedMessages["messages"]> {
    const data = await runActionForData<"getMessages", ReceivedMessages>(
      this.player,
      "getMessages",
      { limit },
      this.opts(options),
    );
    return data.messages;
  }

  // --- waiting -------------------------------------------------------------

  /**
   * Waits until the bot has a form open, then returns it without responding.
   *
   * The wait happens bot-side, so this costs one round trip rather than a poll
   * per interval.
   *
   * @param timeoutMs How long the bot should wait. Defaults to 15 000.
   * @returns The form that opened.
   * @throws {InstructionError} if no form opened in time.
   */
  async waitForForm(timeoutMs = 15_000): Promise<OpenForm> {
    return runActionForData<"waitForForm", OpenForm>(
      this.player,
      "waitForForm",
      { timeoutMs },
      { timeoutMs: timeoutMs + 5_000 },
    );
  }

  /**
   * Waits until the bot receives a message containing the given text.
   *
   * @param contains Case-insensitive substring to look for.
   * @param timeoutMs How long the bot should wait. Defaults to 15 000.
   * @returns The matching message.
   * @throws {InstructionError} if no matching message arrived in time.
   */
  async waitForMessage(
    contains: string,
    timeoutMs = 15_000,
  ): Promise<string> {
    const data = await runActionForData<
      "waitForMessage",
      { message: string; receivedAtMs: number }
    >(
      this.player,
      "waitForMessage",
      { contains, regex: "", timeoutMs },
      { timeoutMs: timeoutMs + 5_000 },
    );
    return data.message;
  }

  // --- forms ---------------------------------------------------------------

  /**
   * Presses a button on the form the bot has open, matching by its label.
   *
   * Matching by label rather than index is deliberate: a test that clicks
   * "Continue" keeps working when a button is inserted above it, whereas a test
   * that clicks index 2 silently starts doing something else.
   *
   * @param text Button label. Matched case-insensitively, ignoring `§` colour
   * codes, preferring an exact match over a substring match.
   * @param options Timeout overrides.
   * @returns Which button was pressed.
   * @throws {InstructionError} if no form is open or no button matches.
   */
  async clickButton(
    text: string,
    options?: RunActionOptions,
  ): Promise<ClickedFormButton> {
    return runActionForData<"clickFormButton", ClickedFormButton>(
      this.player,
      "clickFormButton",
      { text, index: 0 },
      this.opts(options),
    );
  }

  /**
   * Presses a button by its zero-based index. Prefer {@link clickButton}.
   *
   * @param index Zero-based button index.
   * @param options Timeout overrides.
   * @returns Which button was pressed.
   */
  async clickButtonAt(
    index: number,
    options?: RunActionOptions,
  ): Promise<ClickedFormButton> {
    return runActionForData<"clickFormButton", ClickedFormButton>(
      this.player,
      "clickFormButton",
      { text: "", index },
      this.opts(options),
    );
  }

  /**
   * Waits for a form to open and then presses the named button. This is the
   * workhorse for walking a bot through a dialogue chain.
   *
   * @param text Button label, matched as in {@link clickButton}.
   * @param timeoutMs How long to wait for the form. Defaults to 15 000.
   * @returns The form that was answered.
   * @throws {InstructionError} if no form opened or no button matched.
   */
  async awaitFormAndClick(
    text: string,
    timeoutMs = 15_000,
  ): Promise<OpenForm> {
    const form = await this.waitForForm(timeoutMs);
    await this.clickButton(text);
    return form;
  }

  /**
   * Closes the form the bot has open, as though the player dismissed it.
   *
   * @param options Timeout overrides.
   * @returns A promise resolving once the bot confirms the action.
   */
  async closeForm(options?: RunActionOptions): Promise<void> {
    await runAction(
      this.player,
      "menuFormRespond",
      { response: 0, ignore: true },
      this.opts(options),
    );
  }
}

/**
 * Narrows a {@link Vector3} to the wire shape, dropping any extra properties a
 * caller may have passed (a `Block`, for instance, is `Vector3`-shaped).
 *
 * @param value Any vector-shaped value.
 * @returns A plain position object.
 */
function toPos(value: Vector3): Pos {
  return { x: value.x, y: value.y, z: value.z };
}
