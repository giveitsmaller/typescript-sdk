import type { GislSseEvent, GislSseParseFailure } from './types.js';
/**
 * Parse an SSE stream from a fetch Response into an AsyncIterable of typed events.
 *
 * Handles:
 * - Chunk boundary buffering (events split across chunks)
 * - Multi-line `data:` fields (concatenated with newlines)
 * - Comment lines (`:` prefix) used as keep-alives
 * - `id:` and `retry:` fields — IGNORED, and neither is surfaced on
 *   `GislSseEvent`
 *
 * 🔴 THIS SDK DOES NOT RECONNECT. It opens ONE stream and yields frames until
 * the server ends it, the caller breaks, or the signal aborts. There is no
 * retry loop, no backoff, and **no `Last-Event-ID` resumption** — so a dropped
 * connection loses every event published while it was down, and the server
 * cannot replay them.
 *
 * ⚠️ AN EARLIER VERSION OF THIS LINE READ "ignored, SDK manages its own
 * reconnection", WHICH IS FALSE AND SAYS THE OPPOSITE OF THE TRUTH. A reader
 * meeting it concluded retries were handled here. The poll-fallback in `run()`
 * is a DIFFERENT TRANSPORT — it abandons the stream and polls
 * `getWorkflowStatus` — not a reconnection, and it exists only on the
 * ergonomic path. A direct `streamEvents` caller gets no recovery of any kind.
 *
 * ⇒ If you need to survive a drop, wrap this in your own loop AND reconcile
 * the terminal state via `getWorkflowStatus` afterwards, because the gap is
 * unrecoverable from the stream alone. See `docs/typescript/sse.md`.
 *
 * PHP and Python have carried this disclaimer since B2.2; TypeScript is the
 * reference implementation both mirror and was the only one asserting the
 * opposite (hub audit, 2026-08-29).
 *
 * `opts.signal` (optional): when it aborts, the underlying body reader is
 * cancelled. This is the ONLY way to promptly stop a stream parked on a
 * quiet socket: `reader.read()` is suspended, so the generator's `finally`
 * cannot run until that read settles — calling `reader.cancel()` from the
 * abort listener settles it (`{ done: true }`) and runs the stream's cancel
 * algorithm, freeing the connection. (MDN/TC39: an async generator's
 * `return()` is itself unreachable while suspended at `await`; cancellation
 * must be driven externally via an AbortSignal.) `GislClient.streamEvents`
 * owns the controller and wires `return()`/`throw()` → `abort()`.
 *
 * By-design limitation: when called WITHOUT `opts.signal`, there is no
 * cancellation path while `reader.read()` is suspended — a consumer that
 * `break`s / `gen.return()`s on a quiet socket stays stuck until the
 * server sends data or closes (an inherent JS async-generator constraint,
 * not a defect). Pass `opts.signal`, or prefer `GislClient.streamEvents`
 * (which always wires one), whenever early termination must be prompt.
 */
export declare function parseSseStream(response: Response, opts?: {
    signal?: AbortSignal;
    onParseError?: (diagnostic: GislSseParseFailure) => void;
}): AsyncGenerator<GislSseEvent>;
