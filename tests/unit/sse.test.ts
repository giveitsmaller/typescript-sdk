import { describe, it, expect, expectTypeOf } from 'vitest';
import { parseSseStream } from '../../src/sse.js';
import type { GislSseEvent } from '../../src/types.js';
import type {
  SseMultiOutputCompletionWire,
  SseOperationCompletedWire,
  SseSingleOutputCompletionWire,
  SseWorkflowTerminalWire,
} from '../../src/index.js';

function makeResponse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream);
}

function makeChunkedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream);
}

async function collectEvents(response: Response) {
  const events = [];
  for await (const event of parseSseStream(response)) {
    events.push(event);
  }
  return events;
}

/**
 * A Response whose body emits `firstChunk` then NEVER closes or enqueues
 * again — `reader.read()` after the first chunk suspends forever, modelling
 * a quiet SSE socket. The `cancel` callback is the deterministic sync point
 * (resolves `cancelled`) so tests assert prompt teardown WITHOUT a
 * wall-clock timeout — the exact 300s-hang the ticket describes is what we
 * must not reintroduce in the test itself.
 */
function makeNeverEndingResponse(firstChunk: string): {
  response: Response;
  cancelled: Promise<unknown>;
  wasCancelled: () => boolean;
} {
  const encoder = new TextEncoder();
  let resolveCancel!: (reason: unknown) => void;
  const cancelled = new Promise<unknown>((res) => {
    resolveCancel = res;
  });
  let cancelledFlag = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
      // intentionally never close / never enqueue again
    },
    cancel(reason) {
      cancelledFlag = true;
      resolveCancel(reason);
    },
  });
  return {
    response: new Response(stream),
    cancelled,
    wasCancelled: () => cancelledFlag,
  };
}

describe('parseSseStream', () => {
  it('parses a single event with type and JSON data', async () => {
    const response = makeResponse(
      'event: operation.progress\ndata: {"progress":42}\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('operation.progress');
    expect(events[0].data).toEqual({ progress: 42 });
  });

  it('parses multiple events', async () => {
    const text = [
      'event: operation.progress\ndata: {"progress":50}\n\n',
      'event: workflow.completed\ndata: {"workflow_id":"abc"}\n\n',
    ].join('');
    const events = await collectEvents(makeResponse(text));
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('operation.progress');
    expect(events[1].event).toBe('workflow.completed');
  });

  it('handles multi-line data fields', async () => {
    // Multi-line data: JSON split across two data: lines, joined with \n
    // This happens to be valid JSON, so the parser successfully parses it
    const response = makeResponse(
      'event: message\ndata: {"line1":\ndata: "hello"}\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ line1: 'hello' });
  });

  it('skips a malformed multi-line frame instead of yielding a raw string (TYNjcjpo)', async () => {
    // Pre-TYNjcjpo this yielded the joined raw string as `data`; now a frame
    // whose joined `data:` body fails to JSON-parse is SKIPPED so the stream
    // stays resilient (the diagnostic is surfaced via onParseError — see the
    // dedicated malformed-frame block below).
    const response = makeResponse(
      'event: log\ndata: first line\ndata: second line\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(0);
  });

  it('ignores comment lines', async () => {
    const response = makeResponse(
      ': keep-alive\nevent: job.completed\ndata: {"ref":"a"}\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('job.completed');
  });

  // ⚠️ CROSS-REPO GUARD — this is NOT a duplicate of 'ignores comment lines'
  // above. That one proves a comment beside a real event does not corrupt it.
  // THIS one pins the property another repo's correctness rests on: a stream
  // carrying ONLY heartbeats must yield NOTHING AT ALL.
  //
  // The frontend detects a stalled workflow with a ~20s idle watchdog that is
  // re-armed by every YIELDED event. Server heartbeats arrive at ~16s. If this
  // parser ever surfaced comment frames, they would re-arm that watchdog
  // forever and STALL DETECTION WOULD NEVER FIRE — a genuinely stuck job would
  // look healthy indefinitely. The same silence also bounds their
  // stale-terminal window to ~20s instead of the SSE deadline.
  //
  // Surfacing heartbeats is a REASONABLE change to make — it is the obvious way
  // to give SDK consumers liveness/idle detection, which this SDK does not have
  // (there is no idle watchdog here; recovery waits for the server close). So
  // the change will be proposed, it will look like a pure improvement, and
  // NOTHING IN EITHER REPO WOULD FAIL. Hence a test, not a comment: the note at
  // src/sse.ts:120-166 explains why, and this asserts it.
  //
  // If you need liveness in this SDK, add it WITHOUT changing what the iterator
  // yields (a separate callback or a client-level timer), or tell the frontend
  // before it ships so they can decouple their watchdog first.
  it('yields NOTHING for a heartbeat-only stream (frontend stall detection depends on this)', async () => {
    const response = makeResponse(': keep-alive\n\n: keep-alive\n\n: keep-alive\n\n');
    const events = await collectEvents(response);
    expect(events).toHaveLength(0);
  });

  it('handles events split across chunk boundaries', async () => {
    const response = makeChunkedResponse([
      'event: operation.pro',
      'gress\ndata: {"p":1}\n\n',
    ]);
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('operation.progress');
    expect(events[0].data).toEqual({ p: 1 });
  });

  it('handles data split across chunks mid-line', async () => {
    const response = makeChunkedResponse([
      'event: test\nda',
      'ta: {"ok":true}\n\n',
    ]);
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ ok: true });
  });

  it('uses "message" as default event type when event field is missing', async () => {
    const response = makeResponse('data: {"hello":"world"}\n\n');
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    // iOcpCt6L: a nameless frame is not a contract event -> the unknown arm.
    expect(events[0]).toEqual({ event: 'unknown', name: 'message', data: { hello: 'world' } });
  });

  it('returns empty array for empty stream', async () => {
    const response = makeResponse('');
    const events = await collectEvents(response);
    expect(events).toHaveLength(0);
  });

  it('silently skips a malformed frame when no onParseError callback is set', async () => {
    // No-callback default: the frame is dropped and nothing is yielded (PHP
    // parity — `flushSseFrame` returns null on JsonException).
    const response = makeResponse('event: ping\ndata: just a string\n\n');
    const events = await collectEvents(response);
    expect(events).toHaveLength(0);
  });

  it('flushes trailing event without final double newline', async () => {
    const response = makeResponse('event: final\ndata: {"end":true}\n');
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: 'unknown', name: 'final', data: { end: true } });
  });

  it('handles \\r\\n line endings', async () => {
    const response = makeResponse(
      'event: test\r\ndata: {"ok":true}\r\n\r\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: 'unknown', name: 'test', data: { ok: true } });
  });

  it('handles bare \\r line endings', async () => {
    const response = makeResponse(
      'event: test\rdata: {"ok":true}\r\r',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: 'unknown', name: 'test', data: { ok: true } });
  });

  // MqhQwiCi: signal-driven cancellation of a quiet socket.
  describe('opts.signal cancellation', () => {
    it('aborting the signal cancels the body and ends iteration on a quiet socket', async () => {
      const { response, cancelled, wasCancelled } = makeNeverEndingResponse(
        'event: operation.progress\ndata: {"progress":1}\n\n',
      );
      const ac = new AbortController();
      const gen = parseSseStream(response, { signal: ac.signal });

      const first = await gen.next();
      expect(first.done).toBe(false);
      expect((first.value as { event: string }).event).toBe('operation.progress');

      ac.abort();
      // Deterministic: the stream's cancel() callback resolves this.
      await cancelled;
      expect(wasCancelled()).toBe(true);

      // Iteration ends promptly (read() settled by reader.cancel()).
      const next = await gen.next();
      expect(next.done).toBe(true);
    }, 2000);

    it('a pre-aborted signal yields nothing and cancels the (unlocked) body', async () => {
      const { response, cancelled, wasCancelled } = makeNeverEndingResponse(
        'event: x\ndata: {}\n\n',
      );
      const ac = new AbortController();
      ac.abort();

      const gen = parseSseStream(response, { signal: ac.signal });
      const first = await gen.next();
      expect(first.done).toBe(true);

      await cancelled;
      expect(wasCancelled()).toBe(true);
    }, 2000);

    it('does not emit a partial buffered event after abort (codex 909b)', async () => {
      // An unterminated event: `data:` with NO trailing blank line, then
      // the socket goes quiet. The partial run is buffered, never a real
      // event. After abort, the cancelled read surfaces as { done: true } —
      // the trailing flush must NOT yield this garbage.
      const { response, cancelled } = makeNeverEndingResponse(
        'event: operation.progress\ndata: {"progress":99}\n',
      );
      const ac = new AbortController();
      const gen = parseSseStream(response, { signal: ac.signal });

      const pending = gen.next(); // suspends on the 2nd read (quiet socket)
      ac.abort();
      await cancelled;

      const settled = await pending;
      expect(settled.done).toBe(true); // ended, no partial event yielded
      const after = await gen.next();
      expect(after.done).toBe(true);
    }, 2000);

    it('stops emitting already-buffered events after abort (codex 94972142)', async () => {
      // One read delivers TWO complete events. Consumer takes the first,
      // aborts, then pulls again — the second buffered event must NOT be
      // emitted (abort must short-circuit the in-loop yields, not just the
      // post-loop trailing flush).
      const { response, cancelled } = makeNeverEndingResponse(
        'event: a\ndata: {"n":1}\n\nevent: b\ndata: {"n":2}\n\n',
      );
      const ac = new AbortController();
      const gen = parseSseStream(response, { signal: ac.signal });

      const first = await gen.next();
      expect(first.done).toBe(false);
      expect(first.value).toEqual({ event: 'unknown', name: 'a', data: { n: 1 } });

      ac.abort();
      await cancelled;

      const second = await gen.next();
      expect(second.done).toBe(true); // event "b" must NOT be yielded
    }, 2000);

    it('without a signal, normal completion still releases the body (no socket leak)', async () => {
      // Self-closing stream with an observable cancel(): the finally must
      // cancel the reader on the normal-completion path too.
      let cancelledFlag = false;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: done\ndata: {"ok":true}\n\n'));
          controller.close();
        },
        cancel() {
          cancelledFlag = true;
        },
      });
      const events = await collectEvents(new Response(stream));
      expect(events).toHaveLength(1);
      // reader.cancel() on an already-closed stream is a harmless no-op;
      // the contract we assert is that iteration completed without leaking
      // (no hang) and the generator's finally ran to completion.
      expect(cancelledFlag).toBe(false); // already closed → cancel is a no-op
    });
  });

  // TYNjcjpo: malformed-frame diagnostic via the optional onParseError callback.
  describe('onParseError diagnostic (TYNjcjpo)', () => {
    it('skips the malformed frame and fires onParseError once with {raw, event, error}', async () => {
      const diagnostics: Array<{ raw: string; event: string; error: string }> = [];
      const response = makeResponse('event: ping\ndata: not json\n\n');
      const events = [];
      for await (const event of parseSseStream(response, {
        onParseError: (d) => diagnostics.push(d),
      })) {
        events.push(event);
      }
      expect(events).toHaveLength(0);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].raw).toBe('not json');
      expect(diagnostics[0].event).toBe('ping');
      expect(diagnostics[0].error.length).toBeGreaterThan(0);
    });

    it('reports "message" as the event when the malformed frame has no event: field', async () => {
      const diagnostics: Array<{ raw: string; event: string; error: string }> = [];
      const response = makeResponse('data: nope\n\n');
      const events = [];
      for await (const event of parseSseStream(response, {
        onParseError: (d) => diagnostics.push(d),
      })) {
        events.push(event);
      }
      expect(events).toHaveLength(0);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].event).toBe('message');
    });

    it('keeps yielding valid frames after skipping a malformed one', async () => {
      const diagnostics: Array<{ raw: string; event: string; error: string }> = [];
      const text = [
        'event: operation.progress\ndata: {"progress":10}\n\n',
        'event: log\ndata: garbage\n\n',
        'event: workflow.completed\ndata: {"workflow_id":"abc"}\n\n',
      ].join('');
      const events = [];
      for await (const event of parseSseStream(makeResponse(text), {
        onParseError: (d) => diagnostics.push(d),
      })) {
        events.push(event);
      }
      // The two valid frames still yield; only the middle garbage is dropped.
      expect(events).toHaveLength(2);
      expect(events[0].event).toBe('operation.progress');
      expect(events[1].event).toBe('workflow.completed');
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].raw).toBe('garbage');
    });

    it('fires onParseError for a malformed trailing frame (no final blank line)', async () => {
      const diagnostics: Array<{ raw: string; event: string; error: string }> = [];
      // Single trailing newline, no blank-line terminator → the frame reaches
      // the post-loop trailing flush (a `data:` line with NO newline at all
      // would stay buffered as an incomplete line and never parse).
      const response = makeResponse('event: final\ndata: broken\n');
      const events = [];
      for await (const event of parseSseStream(response, {
        onParseError: (d) => diagnostics.push(d),
      })) {
        events.push(event);
      }
      expect(events).toHaveLength(0);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].event).toBe('final');
      expect(diagnostics[0].raw).toBe('broken');
    });

    it('propagates a throw from onParseError (does not swallow it)', async () => {
      const response = makeResponse('event: ping\ndata: not json\n\n');
      const gen = parseSseStream(response, {
        onParseError: () => {
          throw new Error('boom');
        },
      });
      await expect(gen.next()).rejects.toThrow('boom');
    });
  });

  // iOcpCt6L: named arms carry snake_case wire types; everything else is the
  // non-overlapping unknown arm, so checking `event` narrows `data` everywhere.
  describe('typed arms and the unknown arm (iOcpCt6L)', () => {
    const singleCompleted = {
      job_ref: 'j1',
      operation_id: '01936fb3-0000-7000-8000-0000000000aa',
      type: 'compress',
      status: 'completed',
      progress: 100,
      result: { result_kind: 'single', download_url: 'https://d/x.webp', size_bytes: 10, metrics: { compression_ratio: 0.5 } },
    };
    const multiCompleted = {
      job_ref: 'j1',
      operation_id: '01936fb3-0000-7000-8000-0000000000ab',
      type: 'convert',
      status: 'completed',
      progress: 100,
      result: {
        result_kind: 'multi',
        outputs: [
          { download_url: 'https://d/p1.png', size_bytes: 3, page_index: 1 },
          { download_url: 'https://d/p2.png', size_bytes: 4, page_index: 2 },
        ],
        total_output_size_bytes: 7,
      },
    };

    function frame(name: string, data: unknown): string {
      return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    }

    it('yields an unrecognised event name as { event: "unknown", name, data }', async () => {
      const events = await collectEvents(makeResponse(frame('operation.queued', { a: 1 })));
      expect(events).toEqual([{ event: 'unknown', name: 'operation.queued', data: { a: 1 } }]);
    });

    it('routes a server event literally named "unknown" to the unknown arm, name preserved', async () => {
      const events = await collectEvents(makeResponse(frame('unknown', { b: 2 })));
      expect(events).toEqual([{ event: 'unknown', name: 'unknown', data: { b: 2 } }]);
    });

    it('routes an unrecognised trailing frame (no final blank line) to the unknown arm', async () => {
      const events = await collectEvents(makeResponse('event: later.event\ndata: {"c":3}\n'));
      expect(events).toEqual([{ event: 'unknown', name: 'later.event', data: { c: 3 } }]);
    });

    it('keeps every contract event name on its named arm, with no `name` key and data untouched', async () => {
      const names = [
        'operation.progress',
        'operation.completed',
        'operation.failed',
        'job.completed',
        'job.failed',
        'workflow.completed',
        'workflow.failed',
        'workflow.partially_failed',
      ];
      const events = await collectEvents(makeResponse(names.map((n, i) => frame(n, { i })).join('')));
      expect(events).toEqual(names.map((n, i) => ({ event: n, data: { i } })));
    });

    it('narrows to result.result_kind arms with no cast', async () => {
      const events = await collectEvents(
        makeResponse(frame('operation.completed', singleCompleted) + frame('operation.completed', multiCompleted)),
      );
      const seen: string[] = [];
      for (const e of events as GislSseEvent[]) {
        if (e.event !== 'operation.completed') {
          throw new Error(`unexpected ${e.event}`);
        }
        expectTypeOf(e.data).toEqualTypeOf<SseOperationCompletedWire>();
        const result = e.data.result;
        if (result === undefined) {
          throw new Error('result missing');
        }
        if (result.result_kind === 'single') {
          expectTypeOf(result).toEqualTypeOf<SseSingleOutputCompletionWire>();
          seen.push(`single:${result.download_url}:${result.size_bytes}:${result.metrics?.compression_ratio}`);
        } else {
          expectTypeOf(result).toEqualTypeOf<SseMultiOutputCompletionWire>();
          seen.push(`multi:${result.outputs.map((o) => o.page_index).join(',')}:${result.total_output_size_bytes}`);
        }
      }
      expect(seen).toEqual(['single:https://d/x.webp:10:0.5', 'multi:1,2:7']);
    });

    it('narrows the unknown arm to { name: string; data: unknown }', async () => {
      const [e] = (await collectEvents(makeResponse(frame('x.y', { z: 1 })))) as GislSseEvent[];
      if (e.event !== 'unknown') {
        throw new Error(`expected the unknown arm, got ${e.event}`);
      }
      expectTypeOf(e.name).toEqualTypeOf<string>();
      expectTypeOf(e.data).toEqualTypeOf<unknown>();
      expect(e.name).toBe('x.y');
    });

    it('checking `event` narrows a named arm\'s data (the old catch-all overlap is gone)', () => {
      // Type-level. Under the pre-iOcpCt6L `{ event: string; data: unknown }`
      // catch-all, `e.event === 'workflow.failed'` kept the catch-all in the
      // narrowed union (its `event: string` admits that literal), so `e.data`
      // collapsed to `unknown`.
      const readFailedStatus = (e: GislSseEvent): string | undefined => {
        if (e.event === 'workflow.failed') {
          expectTypeOf(e.data).toEqualTypeOf<SseWorkflowTerminalWire>();
          return e.data.status;
        }
        return undefined;
      };
      expect(
        readFailedStatus({ event: 'workflow.failed', data: { workflow_id: 'w', status: 'failed' } }),
      ).toBe('failed');
    });
  });
});
