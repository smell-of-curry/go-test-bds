import { type Player, type Vector3, world } from "@minecraft/server";
import { runAction, runActionForData, type RunActionOptions } from "./client";
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
  PullArtifactsResult,
  ReceivedMessages,
  ScreenshotResult,
  TestArtifact,
  Vec3,
  ViewerMarkParams,
} from "./types";
import { TimeoutError, waitForValue, type WaitOptions } from "./wait";

/** Options for {@link Bot.clickThrough}. */
export interface ClickThroughOptions {
  /**
   * Checked before each form and after each click; the walk stops when it
   * returns true.
   */
  until: () => boolean | Promise<boolean>;
  /**
   * Which button to press on each form: a zero-based index, or a label matched
   * as in {@link Bot.clickButton}. Defaults to the first button, which is the
   * "continue" button in most dialogue chains.
   */
  button?: number | string;
  /**
   * Safety valve for a chain that loops forever, e.g. a form that re-shows
   * itself because the addon rejected the answer. Defaults to 20.
   */
  maxForms?: number;
  /** How long to wait for each form to open. Defaults to 15 000. */
  formTimeoutMs?: number;
  /** Called with each form before it is answered. Useful for logging. */
  onForm?: (form: OpenForm) => void;
  /** What the walk is waiting for, quoted in timeout messages. */
  description?: string;
}

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
  async runCommand(command: string, options?: RunActionOptions): Promise<void> {
    await runAction(this.player, "runCommand", { command }, this.opts(options));
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
  async setHeldSlot(slot: number, options?: RunActionOptions): Promise<void> {
    await runAction(this.player, "setHeldSlot", { slot }, this.opts(options));
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
   * BDS never pushes an inventory write made through the Script API
   * (`Container.setItem`, `addItem`, `swapItems`, `setEquipment`) to the client
   * — only a real inventory transaction resyncs the window. So unless
   * `sync: false` is passed, this first forces that transaction from the server
   * with a marker item that is added and cleared again, leaving the inventory
   * exactly as it was but the client's copy up to date.
   *
   * @param options Timeout overrides, plus `sync: false` to read the client's
   * copy as-is — use that to assert on what the bot has *not* been told.
   * @returns The bot's inventory.
   * @throws if the inventory is full, leaving no slot to sync through.
   */
  async getInventory(
    options?: RunActionOptions & { sync?: boolean },
  ): Promise<BotInventory> {
    if (options?.sync === false) return this.readInventory(options);

    const container = this.player.getComponent(
      "minecraft:inventory",
    )?.container;
    if (!container) throw new Error(`${this.name} has no inventory container`);

    let slot = -1;
    for (let i = 0; i < container.size && slot < 0; i++) {
      if (!container.getItem(i)) slot = i;
    }
    if (slot < 0) {
      throw new Error(
        `cannot sync ${this.name}'s inventory: every slot is occupied`,
      );
    }

    const marker = Bot.SYNC_MARKER;
    const dimension = this.player.dimension;
    const holdsMarker = (inventory: BotInventory) =>
      inventory.items.some((item) => item.name === marker);

    dimension.runCommand(
      `replaceitem entity "${this.name}" slot.inventory ${slot} ${marker} 1`,
    );
    await waitForValue(
      async () => {
        const inventory = await this.readInventory(options);
        return holdsMarker(inventory) ? inventory : undefined;
      },
      { description: `${this.name}'s client to accept an inventory sync` },
    );

    dimension.runCommand(`clear "${this.name}" ${marker} 1`);
    return waitForValue(
      async () => {
        const inventory = await this.readInventory(options);
        return holdsMarker(inventory) ? undefined : inventory;
      },
      { description: `${this.name}'s client to drop the sync marker` },
    );
  }

  /**
   * Item used to force an inventory resync: obtainable only by command, so a
   * test's own items are never mistaken for it.
   *
   * ponytail: `clear` removes one marker by type, so a test that deliberately
   * gives the bot a barrier block loses that one instead. Swap in a custom
   * item with a name tag if that ever matters.
   */
  private static readonly SYNC_MARKER = "minecraft:barrier";

  /**
   * Reads the client's inventory copy without forcing a resync first.
   *
   * @param options Timeout overrides.
   * @returns The bot's inventory as the client currently holds it.
   */
  private async readInventory(
    options?: RunActionOptions,
  ): Promise<BotInventory> {
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
  async waitForMessage(contains: string, timeoutMs = 15_000): Promise<string> {
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
  async awaitFormAndClick(text: string, timeoutMs = 15_000): Promise<OpenForm> {
    const form = await this.waitForForm(timeoutMs);
    await this.clickButton(text);
    return form;
  }

  /**
   * Clicks through a chain of forms until a condition holds.
   *
   * Dialogue chains are the normal way an addon talks to a player, and testing
   * one by naming every button in order is both tedious and locale-dependent —
   * the labels are usually translated. This walks the chain positionally
   * instead, and stops on a condition you can observe from the server (a
   * progress flag, a database record), so the test asserts on the outcome
   * rather than on dialogue wording that designers are free to change.
   *
   * @param options How to walk the chain. See {@link ClickThroughOptions}.
   * @returns The forms that were answered, in order.
   * @throws {InstructionError} if a form opens but has no clickable button.
   * @throws {TimeoutError} if the chain ends, or stalls for longer than
   * `formTimeoutMs`, while `until` is still false.
   */
  async clickThrough(options: ClickThroughOptions): Promise<OpenForm[]> {
    const {
      until,
      button = 0,
      maxForms = 20,
      formTimeoutMs = 15_000,
      onForm,
    } = options;
    const goal = options.description ?? "the expected state";
    const answered: OpenForm[] = [];

    while (!(await until())) {
      if (answered.length >= maxForms) {
        throw new Error(
          `clicked through ${maxForms} forms without reaching ${goal}; ` +
            `last form was "${answered[answered.length - 1]?.title ?? "unknown"}"`,
        );
      }

      let form: OpenForm;
      try {
        form = await this.waitForForm(formTimeoutMs);
      } catch (error) {
        // The chain may finish on the click we already sent, with the condition
        // becoming true a tick later. Re-check before blaming the timeout.
        if (await until()) break;
        throw new TimeoutError(
          `${goal} — no further form opened after answering ${answered.length} ` +
            `(${String(error)})`,
          formTimeoutMs,
        );
      }

      onForm?.(form);
      answered.push(form);
      if (typeof button === "number") await this.clickButtonAt(button);
      else await this.clickButton(button);
    }

    return answered;
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

  // --- viewer ----------------------------------------------------------------

  /**
   * Asks the attached capture harness for a still of this bot's view.
   *
   * @param label Free-text label slugged into the artefact filename.
   * @param options Timeout overrides. Defaults to 5 000 ms for the capture.
   * @returns The written screenshot artefact.
   * @throws {InstructionError} if no viewer is attached or the capture fails.
   */
  async screenshot(
    label = "",
    options?: RunActionOptions,
  ): Promise<ScreenshotResult> {
    const captureTimeoutMs = options?.timeoutMs ?? 5_000;
    return runActionForData<"screenshot", ScreenshotResult>(
      this.player,
      "screenshot",
      { label, timeoutMs: captureTimeoutMs },
      { ...this.opts(options), timeoutMs: captureTimeoutMs + 5_000 },
    );
  }

  /**
   * Broadcasts a run-lifecycle mark to every bot's viewer stream.
   *
   * @param mark Mark fields matching the on-wire `mark` frame.
   * @param options Timeout overrides.
   * @returns A promise resolving once the bot confirms the action.
   */
  async viewerMark(
    mark: ViewerMarkParams,
    options?: RunActionOptions,
  ): Promise<void> {
    await runAction(
      this.player,
      "viewerMark",
      {
        phase: mark.phase,
        runId: mark.runId ?? "",
        suite: mark.suite ?? "",
        test: mark.test ?? "",
        status: mark.status ?? "",
        message: mark.message ?? "",
        elapsedMs: mark.elapsedMs ?? 0,
      },
      this.opts(options),
    );
  }

  /**
   * Drains artefacts written since the last pull.
   *
   * @param options Timeout overrides.
   * @returns Artefacts accumulated since the previous pull.
   */
  async pullArtifacts(options?: RunActionOptions): Promise<TestArtifact[]> {
    const data = await runActionForData<"pullArtifacts", PullArtifactsResult>(
      this.player,
      "pullArtifacts",
      {},
      this.opts(options),
    );
    return data.artifacts ?? [];
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
