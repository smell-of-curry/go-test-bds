/**
 * Minimal `@minecraft/server` stand-in for Node unit tests.
 *
 * Only the surface the SDK touches is modelled. Time is driven by
 * {@link advanceTicks} / {@link advanceTicksAsync} — never by wall-clock sleeps.
 */

type Listener<T> = (event: T) => void;

/** Controllable event signal matching the Script API subscribe shape. */
export class FakeEventSignal<T> {
  private readonly listeners = new Set<Listener<T>>();

  /**
   * @param callback Handler to invoke on dispatch.
   * @returns The same callback (unsubscribe token, as Bedrock does).
   */
  subscribe(callback: Listener<T>): Listener<T> {
    this.listeners.add(callback);
    return callback;
  }

  /**
   * @param callback Handler previously returned from {@link subscribe}.
   */
  unsubscribe(callback: Listener<T>): void {
    this.listeners.delete(callback);
  }

  /**
   * @param event Payload delivered to every subscriber.
   */
  dispatch(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** Drops every subscriber. */
  clear(): void {
    this.listeners.clear();
  }
}

/** Fake player handle used by {@link Bot} and {@link runAction}. */
export interface FakePlayer {
  id: string;
  name: string;
  isValid: boolean;
  sendMessage(message: string): void;
  readonly messages: string[];
}

/**
 * Builds a fake player whose `sendMessage` calls are recorded.
 *
 * @param name Display name.
 * @param id Entity id. Defaults to a stable value derived from `name`.
 * @returns A mutable fake player.
 */
export function createFakePlayer(
  name: string,
  id = `player:${name}`,
): FakePlayer {
  const messages: string[] = [];
  return {
    id,
    name,
    isValid: true,
    messages,
    sendMessage(message: string) {
      messages.push(message);
    },
  };
}

/** Before-chat event shape used by the instruction client. */
export interface FakeChatSendBeforeEvent {
  message: string;
  sender: FakePlayer;
  cancel: boolean;
}

interface ScheduledTask {
  id: number;
  atTick: number;
  callback: () => void;
  intervalTicks?: number;
}

let currentTickValue = 0;
let nextTaskId = 1;
const tasks: ScheduledTask[] = [];

/**
 * Runs every task whose deadline is exactly `tick`, re-arming intervals.
 *
 * @param tick The tick that just became current.
 */
function runDue(tick: number): void {
  const due = tasks.filter((task) => task.atTick === tick);
  for (const task of due) {
    if (task.intervalTicks === undefined) {
      const index = tasks.indexOf(task);
      if (index >= 0) tasks.splice(index, 1);
    } else {
      task.atTick = tick + task.intervalTicks;
    }
    task.callback();
  }
}

/** Controllable `system` matching the methods the SDK calls. */
export const system = {
  get currentTick(): number {
    return currentTickValue;
  },

  /**
   * @param callback Work to run on the next tick pump.
   * @returns Handle accepted by {@link system.clearRun}.
   */
  run(callback: () => void): number {
    return system.runTimeout(callback, 0);
  },

  /**
   * @param callback Work to run after `tickDelay` ticks.
   * @param tickDelay Delay in ticks. Values <= 0 run on the next tick.
   * @returns Handle accepted by {@link system.clearRun}.
   */
  runTimeout(callback: () => void, tickDelay: number): number {
    const id = nextTaskId++;
    // Always schedule in the future so a delay of 0 still needs one advance,
    // matching Script API's "next tick" behaviour for system.run.
    const delay = tickDelay <= 0 ? 1 : tickDelay;
    tasks.push({
      id,
      atTick: currentTickValue + delay,
      callback,
    });
    return id;
  },

  /**
   * @param callback Work to run repeatedly.
   * @param tickInterval Interval in ticks.
   * @returns Handle accepted by {@link system.clearRun}.
   */
  runInterval(callback: () => void, tickInterval: number): number {
    const id = nextTaskId++;
    const intervalTicks = Math.max(1, tickInterval);
    tasks.push({
      id,
      atTick: currentTickValue + intervalTicks,
      callback,
      intervalTicks,
    });
    return id;
  },

  /**
   * @param runId Handle from run / runTimeout / runInterval.
   */
  clearRun(runId: number): void {
    const index = tasks.findIndex((task) => task.id === runId);
    if (index >= 0) tasks.splice(index, 1);
  },

  /**
   * @param ticks How many ticks to wait.
   * @returns A promise that resolves once those ticks have been advanced.
   */
  waitTicks(ticks: number): Promise<void> {
    return new Promise((resolve) => {
      system.runTimeout(() => resolve(), ticks);
    });
  },
};

export const TicksPerSecond = 20;

export const world = {
  beforeEvents: {
    chatSend: new FakeEventSignal<FakeChatSendBeforeEvent>(),
  },
  afterEvents: {
    // Present so TemporaryCallback / future tests can subscribe without crashing.
    playerSpawn: new FakeEventSignal<{ player: FakePlayer }>(),
  },
  /**
   * @returns Currently registered fake players.
   */
  getAllPlayers(): FakePlayer[] {
    return onlinePlayers.slice();
  },
};

const onlinePlayers: FakePlayer[] = [];

/**
 * @param player Player to treat as online.
 */
export function addOnlinePlayer(player: FakePlayer): void {
  if (!onlinePlayers.includes(player)) onlinePlayers.push(player);
}

/**
 * Clears online players. Does not touch event subscriptions — the instruction
 * client subscribes once per process and must keep that listener.
 */
export function clearOnlinePlayers(): void {
  onlinePlayers.length = 0;
}

/**
 * Advances the fake clock by `count` ticks, running due callbacks each step.
 *
 * @param count Number of ticks to advance.
 */
export function advanceTicks(count: number): void {
  for (let i = 0; i < count; i++) {
    currentTickValue += 1;
    runDue(currentTickValue);
  }
}

/**
 * Advances ticks one at a time, flushing microtasks between each so awaited
 * SDK promises can settle without wall-clock sleeps.
 *
 * @param count Number of ticks to advance.
 * @returns A promise that resolves after the last microtask flush.
 */
export async function advanceTicksAsync(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    advanceTicks(1);
    await Promise.resolve();
  }
}

/**
 * Drives the fake scheduler until `promise` settles or `maxTicks` ticks elapse.
 *
 * @param promise The operation under test.
 * @param maxTicks Safety cap so a stuck promise fails the test.
 * @returns The promise's fulfillment value.
 * @throws if the promise rejects, or if it is still pending after `maxTicks`.
 */
export async function driveUntil<T>(
  promise: Promise<T>,
  maxTicks: number,
): Promise<T> {
  let settled = false;
  const tracked = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );

  for (let i = 0; i < maxTicks && !settled; i++) {
    advanceTicks(1);
    await Promise.resolve();
  }

  if (!settled) {
    throw new Error(
      `driveUntil: promise still pending after ${maxTicks} ticks`,
    );
  }
  return tracked;
}

/**
 * Resets the fake clock and clears scheduled work. Keeps world event
 * subscriptions intact so the shared instruction-client listener survives.
 */
export function resetFakeSystem(): void {
  currentTickValue = 0;
  nextTaskId = 1;
  tasks.length = 0;
}

/**
 * Dispatches a before-chat event as though `sender` typed `message`.
 *
 * @param sender The bot player reporting a status.
 * @param message Raw chat text, including any protocol prefix.
 * @returns The event after handlers ran (inspect `cancel`).
 */
export function dispatchChatSend(
  sender: FakePlayer,
  message: string,
): FakeChatSendBeforeEvent {
  const event: FakeChatSendBeforeEvent = {
    message,
    sender,
    cancel: false,
  };
  world.beforeEvents.chatSend.dispatch(event);
  return event;
}
