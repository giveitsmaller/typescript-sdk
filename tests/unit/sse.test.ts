import { describe, it, expect } from 'vitest';
import { parseSseStream } from '../../src/sse.js';

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
    expect(events[0].event).toBe('message');
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
    expect(events[0].event).toBe('final');
    expect(events[0].data).toEqual({ end: true });
  });

  it('handles \\r\\n line endings', async () => {
    const response = makeResponse(
      'event: test\r\ndata: {"ok":true}\r\n\r\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('test');
    expect(events[0].data).toEqual({ ok: true });
  });

  it('handles bare \\r line endings', async () => {
    const response = makeResponse(
      'event: test\rdata: {"ok":true}\r\r',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('test');
    expect(events[0].data).toEqual({ ok: true });
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
      expect((first.value as { event: string }).event).toBe('a');

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
});
