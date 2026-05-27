// TypeScript parity adapter — reference implementation of the parity
// adapter contract (F5 / MZWsS0qs). See docs/sdks/parity-adapter-contract.md
// for the language-neutral interface every adapter implements.
//
// CapturedRequest / CapturedBody shapes live in ./fetch-stub.ts and are
// the normalised form the comparator operates on across all four
// languages.
import { createHmac } from 'node:crypto';

import { GislClient } from '../../src/client.js';
import { OperationBuilder } from '../../src/builder.js';
import { verifyWebhook } from '../../src/webhook.js';

import type { Fixture, FixtureValue } from './fixtures.js';
import { decodeBytesValue } from './fetch-stub.js';

// Ergonomic-facade verbs whose dispatch is wired through `OperationBuilder`
// rather than a direct GislClient method (PHP P2 / 7QXkzoIi symmetric
// addition). Args shape: `[input, options?, terminal?]` where `input` is
// either a `bytes` value (materialised to Blob/File by `materialiseArg`)
// or a string filesystem path; `terminal` is `{run: RunOptions}` or
// `{submit: SubmitOptions}` and defaults to a webhook-bound submit so a
// fixture exercising only the upload+create wire shape doesn't need to
// drive the full run orchestration.
const ERGONOMIC_DISPATCH_VERBS: ReadonlySet<string> = new Set([
  'compress',
  'thumbnail',
  'convert',
  // `watermark` / `archive` deliberately omitted — see fixtures.ts for
  // why (v2 OperationType / multi-input shape mismatches).
]);

const DEFAULT_CLIENT_CONFIG = {
  baseUrl: 'https://api.test.example.com',
  apiKey: 'test-api-key',
  // Force deterministic S3 PUT order for the multipart fixture.
  multipartConcurrency: 1,
};

// Synthesised for fixtures that pass binary bytes to uploadFile. The fixture
// schema describes bytes declaratively; the runner materialises them as Blobs.
// `fixtureFile` is forwarded to decodeBytesValue so `source: file` paths
// resolve relative to the fixture YAML.
function materialiseArg(arg: FixtureValue, fixtureFile: string): unknown {
  if (arg === null || typeof arg !== 'object') {
    return arg;
  }
  // Arrays must recurse so nested bytesValue objects (e.g. a jobs[] list whose
  // entries include a file payload) are materialised too.
  if (Array.isArray(arg)) {
    return arg.map((v) => materialiseArg(v, fixtureFile));
  }
  const obj = arg as { [k: string]: FixtureValue };
  if (obj.kind === 'bytes') {
    const filename = obj.filename as string | undefined;
    const contentType = (obj['content-type'] as string | undefined) ?? 'application/octet-stream';
    const bytes = decodeBytesValue(
      obj as unknown as { kind: 'bytes'; source: 'inline' | 'file' | 'zeros'; value: string },
      fixtureFile,
    );
    // Use a File when the fixture declares a filename so GislClient picks up
    // .name (see client.ts:229). Node 20 has a global File. Casts are required
    // because lib.dom.d.ts's BlobPart expects ArrayBufferView<ArrayBuffer>
    // whereas Node's Buffer-backed Uint8Array is ArrayBufferView<ArrayBufferLike> —
    // runtime-compatible, declaration-incompatible.
    const blobPart = bytes as unknown as BlobPart;
    if (filename) {
      return new File([blobPart], filename, { type: contentType });
    }
    return new Blob([blobPart], { type: contentType });
  }
  // Plain object — recurse so nested bytes markers are materialised too.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = materialiseArg(v, fixtureFile);
  return out;
}

export async function invokeFixture(fixture: Fixture): Promise<{
  returnValue: unknown;
  sseEvents?: unknown[];
  thrown?: unknown;
}> {
  if (fixture.mode === 'webhook') {
    return invokeWebhook(fixture);
  }

  const client = new GislClient({
    ...DEFAULT_CLIENT_CONFIG,
    ...(fixture.sdk.client_config ?? {}),
  } as ConstructorParameters<typeof GislClient>[0]);

  const method = fixture.sdk.method;
  const args = (fixture.sdk.args ?? []).map((a) => materialiseArg(a, fixture.__file));

  // Ergonomic-facade dispatch — PHP P2 (7QXkzoIi) symmetric addition.
  // Routes through `OperationBuilder` instead of `GislClient`'s direct
  // method surface (the ergonomic methods are Proxy-installed in
  // `gisl.create()` and not present on a bare GislClient instance).
  if (ERGONOMIC_DISPATCH_VERBS.has(method)) {
    try {
      const ergonomicReturn = await invokeErgonomic(client, method, args);
      return { returnValue: ergonomicReturn };
    } catch (err) {
      return { returnValue: undefined, thrown: err };
    }
  }

  // Type: all public GislClient methods return Promise<unknown>.
  const fn = (client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
  if (typeof fn !== 'function') {
    throw new Error(`invoke: GislClient has no method "${method}"`);
  }

  let raw: unknown;
  try {
    raw = await fn.apply(client, args);
  } catch (err) {
    // Error-envelope fixtures (expects_error: true) route here. We surface the
    // thrown error so the test can still assert request parity — the SDK's
    // outbound call shape matters even when the server returned 4xx/5xx.
    // Non-error fixtures let the caller propagate via `thrown` → test fails.
    return { returnValue: undefined, thrown: err };
  }

  if (fixture.mode === 'sse') {
    const iterable = raw as AsyncIterable<unknown>;
    const events: unknown[] = [];
    try {
      for await (const ev of iterable) events.push(ev);
    } catch (err) {
      return { returnValue: undefined, sseEvents: events, thrown: err };
    }
    return { returnValue: undefined, sseEvents: events };
  }

  return { returnValue: raw };
}

async function invokeErgonomic(
  client: GislClient,
  method: string,
  args: ReadonlyArray<unknown>,
): Promise<unknown> {
  const input = args[0];
  if (typeof input !== 'string' && !(input instanceof Blob)) {
    throw new Error(
      `invoke: ergonomic "${method}" first arg must be a string path or Blob, got ${typeof input}`,
    );
  }
  const opOptions = (args[1] ?? {}) as Record<string, unknown>;
  const terminal = (args[2] ?? { submit: { webhook: 'https://example.com/webhook' } }) as
    | { submit: { webhook: string } }
    | { run: { maxWait: string | number; useSSE?: boolean; pollIntervalMs?: number } };

  const builder = new OperationBuilder(client, method, input, opOptions);
  if ('submit' in terminal) {
    const handle = await builder.submit({ webhook: terminal.submit.webhook });
    return handle;
  }
  if ('run' in terminal) {
    const result = await builder.run({
      maxWait: terminal.run.maxWait,
      ...(terminal.run.useSSE !== undefined ? { useSSE: terminal.run.useSSE } : {}),
      ...(terminal.run.pollIntervalMs !== undefined
        ? { pollIntervalMs: terminal.run.pollIntervalMs }
        : {}),
    });
    return result;
  }
  throw new Error(
    `invoke: ergonomic "${method}" terminal must declare exactly one of 'run' or 'submit'`,
  );
}

function invokeWebhook(fixture: Fixture): { returnValue: unknown; thrown?: unknown } {
  if (!fixture.webhook) {
    throw new Error(`invoke: fixture ${fixture.name} has mode=webhook but no webhook block`);
  }
  const { secret, body, expected_signature_hex, header_format = 'sha256={hex}' } = fixture.webhook;

  // Parity property: every runner must INDEPENDENTLY compute
  //   HMAC-SHA256(secret, body).hex()
  // and assert it equals expected_signature_hex. Reusing the committed hex as
  // the signature input defeats the cross-SDK check (two buggy SDKs with the
  // same bug would pass). We compute the digest ourselves first, then round-
  // trip through verifyWebhook to cover the signature-parsing path too.
  const computedHex = createHmac('sha256', secret).update(body).digest('hex');
  if (computedHex !== expected_signature_hex) {
    throw new Error(
      `[${fixture.name}] webhook parity failure: computed HMAC ${computedHex} ` +
        `!= fixture expected_signature_hex ${expected_signature_hex}`,
    );
  }

  const header = header_format.replace('{hex}', computedHex);
  try {
    const ok = verifyWebhook(secret, header, body);
    return { returnValue: ok };
  } catch (err) {
    // verifyWebhook throws on a mismatch; with a freshly-computed hex that
    // should never happen, but surface as a structured test failure rather
    // than a runaway exception so the harness message is actionable.
    return { returnValue: false, thrown: err };
  }
}
