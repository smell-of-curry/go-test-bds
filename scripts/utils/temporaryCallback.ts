import {
  TicksPerSecond,
  type WorldAfterEvents,
  type WorldBeforeEvents,
  system,
  world,
} from "@minecraft/server";

/**
 * Picks either WorldBeforeEvents or WorldAfterEvents
 */
type WorldEvents<E extends "beforeEvents" | "afterEvents"> =
  E extends "beforeEvents" ? WorldBeforeEvents : WorldAfterEvents;

/**
 * Narrows keys to only those whose values contain a `.subscribe(...)` method.
 */
type KeysThatCanSubscribe<T> = {
  [K in keyof T]: T[K] extends { subscribe: (...args: any[]) => any }
    ? K
    : never;
}[keyof T];

/**
 * If T[K] has a `.subscribe(...)`, extract that function type.
 * Otherwise yields `never`.
 */
type ExtractSubscribeFn<T, K extends keyof T> = T[K] extends {
  subscribe: (...args: any[]) => any;
}
  ? T[K]["subscribe"]
  : never;

/**
 * For "beforeEvents"/"afterEvents", pick only valid event keys
 * and then get the type of `.subscribe(...)` for that event.
 */
type EventSubscribeFn<
  E extends "beforeEvents" | "afterEvents",
  T extends KeysThatCanSubscribe<WorldEvents<E>>,
> = ExtractSubscribeFn<WorldEvents<E>, T>;

/**
 * Extracts the "event data" type from something shaped like
 * `subscribe((data: SomeData) => void, options?: SomeOptions) => Token`.
 */
type ExtractEventData<TSubscribe> = TSubscribe extends (
  callback: (ev: infer TEventData) => any,
  ...rest: any[]
) => any
  ? TEventData
  : unknown;

/**
 * Extracts the "options" parameter from the second param of `.subscribe(...)`.
 */
type ExtractEventOptions<TSubscribe> = TSubscribe extends (
  listener: any,
  options?: infer TOptions,
) => any
  ? TOptions
  : never;

/**
 * Shape of a typical event signal: has subscribe/unsubscribe.
 * You can adapt the generics to match exactly what's in @minecraft/server.
 */
interface IEventSignal<Data, ReturnToken, Options = undefined> {
  subscribe(listener: (data: Data) => void, options?: Options): ReturnToken;
  unsubscribe(token: ReturnToken): void;
}

/**
 * A map of event timeouts, so we can auto-expire them.
 */
const eventTimeouts = new Map<
  number,
  {
    eventSignal: IEventSignal<any, any, any>;
    subscriptionToken: number;
  }
>();

export class TemporaryCallback {
  /**
   * Registers a callback for a given "beforeEvents" or "afterEvents".
   *
   * @param eventType - "beforeEvents" or "afterEvents"
   * @param eventId   - Which specific event in that group
   * @param callback  - The callback to run
   *        - `remove` is a function to expire the callback
   *        - `data` is the event data
   * @param options   - Options for the subscription (if any)
   * @param timeout   - Ticks before auto-expire (defaults to 3 seconds)
   * @param complete  - A function that is called when the callback completes or expires
   */
  static subscribe<
    E extends "beforeEvents" | "afterEvents",
    // Restrict T to only those keys that actually can be subscribed.
    T extends KeysThatCanSubscribe<WorldEvents<E>>,
  >(
    eventType: E,
    eventId: T,
    callback: (
      remove: () => void,
      data: ExtractEventData<EventSubscribeFn<E, T>>,
    ) => void,
    options?: ExtractEventOptions<EventSubscribeFn<E, T>>,
    timeout: number = TicksPerSecond * 3,
    complete?: (expired: boolean) => void,
    subscribeNextTick: boolean = false,
  ) {
    let alreadyRemoved = false;

    /**
     * The type of "unsubscribe token" returned by .subscribe(...).
     * We glean it from the return type of the relevant subscribe(...) function.
     */
    type ReturnToken = ReturnType<EventSubscribeFn<E, T>>;

    let subscriptionToken: ReturnToken;
    let eventTimeout = -1;

    // Safely cast the event from "world.beforeEvents/afterEvents" to something
    // with subscribe/unsubscribe. Because we used KeysThatCanSubscribe, we know
    // this cast is correct at the type level.
    const eventSignal = (world[eventType] as WorldEvents<E>)[
      eventId
    ] as IEventSignal<
      ExtractEventData<EventSubscribeFn<E, T>>,
      ReturnToken,
      ExtractEventOptions<EventSubscribeFn<E, T>>
    >;

    // The actual subscriber callback we'll pass to `subscribe(...)`
    const eventHandler = (data: ExtractEventData<EventSubscribeFn<E, T>>) => {
      callback(() => {
        if (alreadyRemoved) return;
        eventSignal.unsubscribe(subscriptionToken);
        system.clearRun(eventTimeout);
        eventTimeouts.delete(eventTimeout);
        alreadyRemoved = true;
        complete?.(false);
      }, data);
    };

    // Subscribe, using options only if present
    const subscribe = () => {
      subscriptionToken = options
        ? eventSignal.subscribe(eventHandler, options)
        : eventSignal.subscribe(eventHandler);

      // Auto-expire in X ticks
      eventTimeout = system.runTimeout(() => {
        if (alreadyRemoved) return;
        eventSignal.unsubscribe(subscriptionToken);
        alreadyRemoved = true;
        complete?.(true);
      }, timeout);
      eventTimeouts.set(eventTimeout, {
        eventSignal,
        subscriptionToken,
      });
    };

    if (subscribeNextTick) system.run(() => subscribe());
    else subscribe();
  }

  /**
   * Clears all temporary callbacks.
   */
  static clearAll() {
    for (const [timeout, data] of eventTimeouts) {
      data.eventSignal.unsubscribe(data.subscriptionToken);
      system.clearRun(timeout);
    }
    eventTimeouts.clear();
  }

  /**
   * Subscribes to an event and returns a promise that resolves when the event occurs or times out
   * @param eventType The type of event to subscribe to
   * @param eventId The ID of the event to subscribe to
   * @param options Optional subscription options
   * @param timeout Optional timeout in ticks (defaults to 3 seconds)
   * @returns A promise that resolves with the event data or rejects if the event times out
   */
  static subscribeAsync<
    E extends "beforeEvents" | "afterEvents",
    T extends KeysThatCanSubscribe<WorldEvents<E>>,
  >(
    eventType: E,
    eventId: T,
    options?: ExtractEventOptions<EventSubscribeFn<E, T>>,
    timeout: number = TicksPerSecond * 3,
  ): Promise<ExtractEventData<EventSubscribeFn<E, T>>> {
    return new Promise((resolve, reject) => {
      this.subscribe(
        eventType,
        eventId,
        (remove, data) => {
          remove();
          resolve(data);
        },
        options,
        timeout,
        (expired) => {
          if (expired) {
            reject(
              new Error(
                `Event ${String(eventId)} timed out after ${timeout} ticks`,
              ),
            );
          }
        },
      );
    });
  }
}
