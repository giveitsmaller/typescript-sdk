import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { vi } from 'vitest';

import type { FixtureResponse } from './fixtures.js';

// ---------------------------------------------------------------------------
// Captured request — language-neutral normalised form. Runners in other SDKs
// will produce the same shape when they capture their HTTP client's outbound
// calls, so comparators.ts operates on this shape exclusively.
// ---------------------------------------------------------------------------

export interface CapturedMultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  bytes?: Uint8Array;
  text?: string;
}

export type CapturedBody =
  | { type: 'empty' }
  | { type: 'json'; value: unknown }
  | { type: 'text'; value: string }
  | { type: 'raw'; bytes: Uint8Array }
  | { type: 'multipart'; parts: CapturedMultipartPart[] };

export interface CapturedRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string[]>;
  headers: Record<string, string>;
  body: CapturedBody;
}

export interface FetchStub {
  install(responses: FixtureResponse[], fixtureFile?: string): void;
  restore(): void;
  readonly captured: CapturedRequest[];
}

export function createFetchStub(): FetchStub {
  const captured: CapturedRequest[] = [];
  let queue: FixtureResponse[] = [];
  let fixtureFile: string | undefined;
  let installed = false;
  // Snapshot the prior global fetch on install so restore() can put it back
  // without calling vi.unstubAllGlobals(), which would blow away any
  // unrelated stubs set by sibling tests in the same worker.
  let priorFetch: typeof globalThis.fetch | undefined;

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = normalizeHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = await captureBody(init?.body, headers['content-type']);

    const parsed = parseUrl(url);
    captured.push({
      method,
      url,
      path: parsed.path,
      query: parsed.query,
      headers,
      body,
    });

    if (queue.length === 0) {
      throw new Error(
        `parity fetch stub: no canned response for request #${captured.length} (${method} ${url})`,
      );
    }

    const next = queue.shift()!;
    return buildResponse(next, fixtureFile);
  };

  return {
    install(responses, file) {
      // Double-install would overwrite priorFetch with the already-stubbed
      // fetch, so restore() could leave globalThis.fetch permanently stubbed.
      // Require a matching restore() between installs.
      if (installed) {
        throw new Error(
          'parity fetch stub: install() called twice without restore() in between',
        );
      }
      queue = [...responses];
      fixtureFile = file;
      captured.length = 0;
      priorFetch = globalThis.fetch;
      vi.stubGlobal('fetch', vi.fn(fetchImpl));
      installed = true;
    },
    restore() {
      if (installed) {
        // Restore exactly the fetch we replaced. Avoids vi.unstubAllGlobals'
        // broader blast radius, which would clobber any unrelated global
        // stubs set by sibling tests running in the same worker.
        if (priorFetch !== undefined) {
          globalThis.fetch = priorFetch;
        } else {
          delete (globalThis as { fetch?: unknown }).fetch;
        }
        priorFetch = undefined;
        installed = false;
      }
      queue = [];
      fixtureFile = undefined;
      captured.length = 0;
    },
    captured,
  };
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normalizeHeaders(raw: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (raw instanceof Headers) {
    raw.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  }
  if (Array.isArray(raw)) {
    for (const [k, v] of raw) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
  return out;
}

function parseUrl(url: string): { path: string; query: Record<string, string[]> } {
  // Absolute URLs (presigned S3, etc.) go through URL; relative paths are
  // impossible here because GislClient prepends baseUrl before calling fetch.
  const parsed = new URL(url);
  const query: Record<string, string[]> = {};
  for (const [k, v] of parsed.searchParams.entries()) {
    (query[k] ??= []).push(v);
  }
  return { path: parsed.pathname, query };
}

async function captureBody(
  body: BodyInit | null | undefined,
  contentType: string | undefined,
): Promise<CapturedBody> {
  if (body === null || body === undefined) return { type: 'empty' };

  if (body instanceof FormData) {
    const parts: CapturedMultipartPart[] = [];
    for (const [name, value] of body.entries()) {
      if (typeof value === 'string') {
        parts.push({ name, text: value });
      } else {
        const blob = value as Blob;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        parts.push({
          name,
          filename: (blob as File).name,
          contentType: blob.type || undefined,
          bytes,
        });
      }
    }
    return { type: 'multipart', parts };
  }

  if (body instanceof URLSearchParams) {
    return { type: 'text', value: body.toString() };
  }

  if (body instanceof ArrayBuffer) {
    return { type: 'raw', bytes: new Uint8Array(body) };
  }

  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return {
      type: 'raw',
      bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    };
  }

  if (body instanceof Blob) {
    const bytes = new Uint8Array(await body.arrayBuffer());
    return { type: 'raw', bytes };
  }

  if (typeof body === 'string') {
    const ct = (contentType ?? '').toLowerCase();
    if (ct.includes('application/json') || ct.includes('+json')) {
      try {
        return { type: 'json', value: JSON.parse(body) };
      } catch {
        // fall through to text
      }
    }
    return { type: 'text', value: body };
  }

  // ReadableStream or other — surface as raw if possible. Parity fixtures do
  // not exercise this path today; fail loudly if we encounter it.
  throw new Error(`parity fetch stub: unsupported body type ${Object.prototype.toString.call(body)}`);
}

// ---------------------------------------------------------------------------
// Response builder — maps FixtureResponse to a real Response object the SDK
// can consume.
// ---------------------------------------------------------------------------

function buildResponse(res: FixtureResponse, fixtureFile: string | undefined): Response {
  const headers = new Headers(res.headers ?? {});
  const status = res.status;

  if (!res.body || res.body.type === 'empty') {
    return new Response(null, { status, headers });
  }

  const body = res.body;
  switch (body.type) {
    case 'json':
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return new Response(JSON.stringify(body.value), { status, headers });
    case 'text':
      if (!headers.has('content-type')) {
        headers.set('content-type', 'text/plain');
      }
      return new Response(body.value, { status, headers });
    case 'sse_stream': {
      if (!headers.has('content-type')) {
        headers.set('content-type', 'text/event-stream');
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of body.chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, { status, headers });
    }
    case 'raw': {
      const bytes = decodeBytesValue(body.content, fixtureFile);
      // Response accepts Uint8Array at runtime; lib.dom.d.ts's BodyInit is
      // stricter so we cast via unknown to keep this a single line.
      return new Response(bytes as unknown as BodyInit, { status, headers });
    }
    default:
      throw new Error(
        `parity fetch stub: unsupported response body type "${(body as { type: string }).type}"`,
      );
  }
}

export function decodeBytesValue(
  v: { kind: 'bytes'; source: 'inline' | 'file' | 'zeros'; value: string },
  fixtureFile?: string,
): Uint8Array {
  if (v.source === 'inline') {
    // Node and browser both support Buffer/atob; prefer Buffer on Node.
    return new Uint8Array(Buffer.from(v.value, 'base64'));
  }
  if (v.source === 'zeros') {
    // Decimal byte count. Exists for the multipart-upload fixture whose 8MB
    // first chunk would otherwise bloat the YAML.
    const n = Number(v.value);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `parity fetch stub: bytes source "zeros" value must be a non-negative integer, got "${v.value}"`,
      );
    }
    // Cap to prevent a malformed or malicious fixture from exhausting memory.
    // The largest real use case is the 10MB multipart upload; 64MB leaves
    // headroom without inviting accidents.
    const MAX_ZEROS_BYTES = 64 * 1024 * 1024;
    if (n > MAX_ZEROS_BYTES) {
      throw new Error(
        `parity fetch stub: bytes source "zeros" value ${n} exceeds cap ${MAX_ZEROS_BYTES} (64MB). ` +
          `Use source: file for payloads larger than this.`,
      );
    }
    return new Uint8Array(n);
  }
  if (v.source === 'file') {
    if (!fixtureFile) {
      throw new Error(
        `parity fetch stub: bytes source "file" requires the fixture path to resolve "${v.value}"`,
      );
    }
    // Relative paths resolve from the fixture file's directory so fixtures can
    // ship binary payloads alongside themselves (e.g. upload_multipart.yaml
    // + upload_multipart.bin in the same fixtures/ folder). Absolute paths are
    // rejected — fixtures must be self-contained under tests/parity/fixtures/.
    if (isAbsolute(v.value)) {
      throw new Error(
        `parity fetch stub: bytes source "file" path must be relative to the fixture; got absolute "${v.value}"`,
      );
    }
    const fixtureDir = dirname(fixtureFile);
    const resolved = resolve(fixtureDir, v.value);
    // Reject '..' escapes out of the fixture directory. Fixtures are in-repo
    // trusted content but a fixture authored in a PR should not be able to
    // read arbitrary files on a reviewer's machine during UPDATE_PARITY_FIXTURES=1 or CI.
    if (!resolved.startsWith(fixtureDir + sep) && resolved !== fixtureDir) {
      throw new Error(
        `parity fetch stub: bytes source "file" must stay under the fixture directory; got "${v.value}"`,
      );
    }
    // Resolve symlinks. A fixture could place a symlink inside fixtures/
    // pointing at /etc/passwd — the prefix check above does not catch that.
    // realpathSync follows the chain; we then re-verify containment.
    const realFixtureDir = realpathSync(fixtureDir);
    const realResolved = realpathSync(resolved);
    if (!realResolved.startsWith(realFixtureDir + sep) && realResolved !== realFixtureDir) {
      throw new Error(
        `parity fetch stub: bytes source "file" resolves (via symlink) outside the fixture directory; got "${v.value}"`,
      );
    }
    return new Uint8Array(readFileSync(realResolved));
  }
  throw new Error(`parity fetch stub: bytes source "${(v as { source: string }).source}" not supported`);
}
