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

  it('returns raw string when multi-line data is not valid JSON', async () => {
    const response = makeResponse(
      'event: log\ndata: first line\ndata: second line\n\n',
    );
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('first line\nsecond line');
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

  it('handles non-JSON data as raw string', async () => {
    const response = makeResponse('event: ping\ndata: just a string\n\n');
    const events = await collectEvents(response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('just a string');
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
});
