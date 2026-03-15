import type { GislSseEvent } from './types.js';

/**
 * Parse an SSE stream from a fetch Response into an AsyncIterable of typed events.
 *
 * Handles:
 * - Chunk boundary buffering (events split across chunks)
 * - Multi-line `data:` fields (concatenated with newlines)
 * - Comment lines (`:` prefix) used as keep-alives
 * - `retry:` field (ignored, SDK manages its own reconnection)
 */
export async function* parseSseStream(
  response: Response,
): AsyncGenerator<GislSseEvent> {
  const body = response.body;
  if (!body) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = '';
  let dataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE spec allows \n, \r\n, and \r as line endings
      const lines = buffer.replace(/\r\n?/g, '\n').split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line === '') {
          // Empty line = end of event
          if (dataLines.length > 0) {
            const rawData = dataLines.join('\n');
            let parsed: unknown;
            try {
              parsed = JSON.parse(rawData);
            } catch {
              parsed = rawData;
            }
            yield {
              event: eventType || 'message',
              data: parsed,
            } as GislSseEvent;
          }
          eventType = '';
          dataLines = [];
          continue;
        }

        if (line.startsWith(':')) {
          // Comment line (keep-alive), skip
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

    // Flush any remaining buffered event
    if (dataLines.length > 0) {
      const rawData = dataLines.join('\n');
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        parsed = rawData;
      }
      yield {
        event: eventType || 'message',
        data: parsed,
      } as GislSseEvent;
    }
  } finally {
    reader.releaseLock();
  }
}
