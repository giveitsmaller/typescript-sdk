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
export async function* parseSseStream(response, opts = {}) {
    const body = response.body;
    if (!body) {
        return;
    }
    const signal = opts.signal;
    if (signal?.aborted) {
        // Pre-aborted: the body is still unlocked (no reader yet), so cancel it
        // directly to free the connection, then yield nothing.
        await body.cancel().catch(() => { });
        return;
    }
    const reader = body.getReader();
    // `reader.cancel()` is valid while the reader holds the lock (unlike
    // `body.cancel()`, which throws "Cannot cancel a locked stream"). It
    // settles the in-flight `reader.read()` with `{ done: true }` and runs
    // the stream's cancel algorithm. We track `aborted` so the post-loop
    // trailing flush below does NOT emit a partial, never-terminated event
    // once the consumer has abandoned the stream (the cancelled read looks
    // exactly like a clean EOF — `{ done: true }` — but a buffered
    // unterminated `data:` run after an abort is garbage, not an event).
    let aborted = false;
    const onAbort = () => {
        aborted = true;
        void reader.cancel().catch(() => { });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
    let dataLines = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            // SSE spec allows \n, \r\n, and \r as line endings
            const lines = buffer.replace(/\r\n?/g, '\n').split('\n');
            // Keep the last (potentially incomplete) line in the buffer
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                // If a single read delivered multiple complete events and the
                // consumer aborted after receiving an earlier one (we were
                // suspended at `yield`), do NOT keep emitting the remaining
                // buffered events on resume — stop processing this batch.
                if (aborted)
                    break;
                if (line === '') {
                    // Empty line = end of event
                    if (dataLines.length > 0) {
                        const rawData = dataLines.join('\n');
                        const frameEvent = eventType || 'message';
                        let parsed;
                        try {
                            parsed = JSON.parse(rawData);
                        }
                        catch (err) {
                            // TYNjcjpo — a malformed-JSON frame is SKIPPED (not yielded as a
                            // raw string) so the stream stays resilient, but the failure is
                            // surfaced via the optional onParseError diagnostic rather than
                            // silently lost. Identical to the PHP `flushSseFrame` drop-path.
                            opts.onParseError?.({
                                raw: rawData,
                                event: frameEvent,
                                error: err instanceof Error ? err.message : String(err),
                            });
                            eventType = '';
                            dataLines = [];
                            continue;
                        }
                        yield {
                            event: frameEvent,
                            data: parsed,
                        };
                    }
                    eventType = '';
                    dataLines = [];
                    continue;
                }
                if (line.startsWith(':')) {
                    // Comment line (keep-alive), skip.
                    //
                    // ⚠️ DO NOT "FIX" THIS INTO SURFACING COMMENT FRAMES WITHOUT READING
                    // THIS. Dropping them is CORRECT per the SSE spec — a comment carries
                    // no event — but it is also LOAD-BEARING FOR A CONSUMER, and that
                    // consumer is in another repo.
                    //
                    // The frontend does NOT close its SSE reader on the terminal event:
                    // `workflow_completed` patches status and breaks WITHOUT aborting.
                    // What actually closes the stream is an IDLE WATCHDOG at 20s. That
                    // watchdog only fires because heartbeats are never yielded here, so
                    // they never re-arm it — roughly 20s after the last real event the
                    // reader closes and the PHP worker is released.
                    //
                    // HEARTBEAT ~16s vs IDLE TIMEOUT 20s: a FOUR-SECOND MARGIN that holds
                    // only while the heartbeats are invisible. Surfacing comment frames —
                    // a completely reasonable change, since EventSource semantics treat
                    // keep-alive comments as liveness signals that legitimately reset
                    // timeouts — would CONTINUOUSLY re-arm the watchdog. The stream would
                    // never go idle, and every completed job left on screen would hold a
                    // PHP worker for the full 570s. That is worker exhaustion from
                    // ordinary users leaving tabs open.
                    //
                    // A ONE-LINE CHANGE HERE SILENTLY CONVERTS THE FRONTEND FROM BOUNDED
                    // TO UNBOUNDED, and nothing on either side would flag it.
                    //
                    // ⚠️ THIS NOTE IS PERMANENT. DO NOT DELETE IT WHEN THE FRONTEND
                    // ADDS AN EXPLICIT CLOSE-ON-TERMINAL. That fix removes the TERMINAL
                    // case and does NOT remove the dependency, because closing finished
                    // streams was never the watchdog's job — that was a side effect
                    // nobody knew about until 2026-08-12.
                    //
                    // THE WATCHDOG'S ACTUAL JOB IS DETECTING A STREAM THAT HAS GONE
                    // SILENT WHILE THE WORKFLOW IS STILL RUNNING, and resuming the
                    // fallback poll. That case survives every fix in flight, and it is
                    // not exotic: a long operation between progress events produces it
                    // exactly — heartbeats flowing, no data frames, job still running.
                    //
                    // If this parser surfaced comment frames, heartbeats at ~16s would
                    // re-arm the 20s watchdog FOREVER and STALL DETECTION WOULD NEVER
                    // FIRE AT ALL, on a stream that is genuinely stuck. The UI would go
                    // on believing a dead job is fine. That is worse than the worker
                    // leak: a leak is bounded by 570s, a missed stall is not bounded at
                    // all.
                    //
                    // The PHP SDK does the same thing at GislClient.php (`$line[0] === ':'`),
                    // verified 2026-08-12 — the two languages agree on this axis, and
                    // they must stay agreed: this property governs whether a stuck
                    // stream is EVER detected, so a divergence here is not cosmetic.
                    continue;
                }
                const colonIndex = line.indexOf(':');
                if (colonIndex === -1) {
                    continue;
                }
                const field = line.slice(0, colonIndex);
                // Strip single leading space after colon per SSE spec
                const valueStart = line[colonIndex + 1] === ' ' ? colonIndex + 2 : colonIndex + 1;
                const fieldValue = line.slice(valueStart);
                switch (field) {
                    case 'event':
                        eventType = fieldValue;
                        break;
                    case 'data':
                        dataLines.push(fieldValue);
                        break;
                    case 'retry':
                        // Ignored — SDK manages its own polling/reconnection
                        break;
                }
            }
        }
        // Flush any remaining buffered event — but ONLY on a genuine
        // end-of-stream (server closed without a final blank line). After an
        // abort, the cancelled read also surfaces as `{ done: true }`, yet a
        // partial unterminated `data:` buffer is not a real event and must
        // not be yielded once the consumer has abandoned the stream.
        if (!aborted && dataLines.length > 0) {
            const rawData = dataLines.join('\n');
            const frameEvent = eventType || 'message';
            let parsed;
            try {
                parsed = JSON.parse(rawData);
            }
            catch (err) {
                // TYNjcjpo — trailing-flush malformed frame: skip + diagnostic (same as
                // the in-loop path above).
                opts.onParseError?.({
                    raw: rawData,
                    event: frameEvent,
                    error: err instanceof Error ? err.message : String(err),
                });
                return;
            }
            yield {
                event: frameEvent,
                data: parsed,
            };
        }
    }
    finally {
        signal?.removeEventListener('abort', onAbort);
        // Cancel the body so the underlying HTTP connection is released on
        // EVERY exit path (early `return()`/abort AND normal completion) — a
        // bare `releaseLock()` leaves the socket open until GC. Cancelling an
        // already-closed/cancelled stream is a harmless no-op that resolves.
        try {
            await reader.cancel();
        }
        catch {
            /* stream already errored/closed — nothing to release */
        }
        reader.releaseLock();
    }
}
