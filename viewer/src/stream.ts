import type { Frame } from "./protocol";

/** Shortest gap between resyncs triggered by an unreadable frame. */
const RESYNC_INTERVAL_MS = 2_000;

export type StreamHandlers = {
  onFrame: (frame: Frame) => void;
  onError?: (err: Error) => void;
  onOpen?: () => void;
};

/**
 * SSE client. Relies on the browser's EventSource reconnect; the server always
 * opens with hello + keyframe, so resync is "keyframe replaces the world".
 */
export class SnapshotStream {
  private source: EventSource | null = null;
  private readonly url: string;
  private readonly handlers: StreamHandlers;
  private closed = false;
  private lastResyncAt = 0;

  constructor(url: string, handlers: StreamHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.source?.close();
    this.source = null;
  }

  /**
   * Drop the connection so the server sends a fresh keyframe.
   *
   * At most once every {@link RESYNC_INTERVAL_MS}.
   */
  private resync(): void {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastResyncAt < RESYNC_INTERVAL_MS) return;
    this.lastResyncAt = now;
    this.source?.close();
    this.source = null;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const es = new EventSource(this.url);
    this.source = es;

    es.onopen = () => this.handlers.onOpen?.();

    es.onerror = () => {
      // EventSource reconnects on its own; surface a soft error for the overlay.
      this.handlers.onError?.(
        new Error("stream connection error (reconnecting)"),
      );
    };

    for (const type of [
      "hello",
      "keyframe",
      "delta",
      "mark",
      "capture",
      "chat",
      "title",
      "particle",
      "phud",
      "formHover",
    ] as const) {
      es.addEventListener(type, (ev: MessageEvent<string>) => {
        try {
          const frame = JSON.parse(ev.data) as Frame;
          if (frame.type !== type) {
            throw new Error(
              `event ${type} carried type=${String((frame as Frame).type)}`,
            );
          }
          this.handlers.onFrame(frame);
        } catch (err) {
          this.handlers.onError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
          // A frame that throws leaves the world half-applied, and every frame
          // after it builds on that. Reconnecting is the resync: the server
          // always opens with hello + keyframe. Rate-limited so a frame the
          // client simply cannot read does not become a reconnect loop.
          this.resync();
        }
      });
    }
  }
}

/**
 * Resolve the stream URL from the page query string.
 *
 * @param search - `location.search` (including leading `?`).
 * @returns absolute EventSource URL.
 */
export function streamUrlFromSearch(search: string): string {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const explicit = params.get("stream");
  if (explicit) return explicit;
  const bot = params.get("bot");
  const base = params.get("base") ?? `${location.protocol}//${location.host}`;
  const url = new URL("/stream", base);
  if (bot) url.searchParams.set("bot", bot);
  return url.toString();
}
