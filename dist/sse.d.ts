import type { GislSseEvent, GislSseParseFailure } from './types.js';
/**
 * Parse an SSE stream from a fetch Response into an AsyncIterable of typed events.
 *
 * Handles:
 * - Chunk boundary buffering (events split across chunks)
 * - Multi-line `data:` fields (concatenated with newlines)
 * - Comment lines (`:` prefix) used as keep-alives
 * - `retry:` field (ignored, SDK manages its own reconnection)
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
