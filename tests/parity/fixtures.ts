import { readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { resolveParityFixturesDir } from './_fixture-paths.js';

// ---------------------------------------------------------------------------
// Fixture shape (TypeScript mirror of tests/parity/fixture.schema.json).
// The runtime validator below enforces the invariants that matter for test
// soundness — token-string typos, method enum, requests/responses length,
// scientific-notation numbers. The full JSON Schema is documentation for
// fixture authors and future language runners.
// ---------------------------------------------------------------------------

export type FixtureMode = 'request_response' | 'sse' | 'webhook';

export type FixtureValue =
  | null
  | boolean
  | number
  | string
  | FixtureValue[]
  | { [key: string]: FixtureValue };

export interface BytesValue {
  kind: 'bytes';
  // inline: `value` is base64. file: `value` is a path relative to the fixture.
  // zeros: `value` is the decimal byte count — decoded as N zero bytes. Exists
  // so the multipart-upload fixture can assert an 8MB+ payload without shipping
  // a giant binary or a 14MB base64 blob in the YAML.
  source: 'inline' | 'file' | 'zeros';
  value: string;
}

export type MultipartPartContent =
  | BytesValue
  | { kind: 'json'; value: FixtureValue }
  | { kind: 'text'; value: string };

export interface MultipartPart {
  name: string;
  filename?: string;
  'content-type'?: string;
  content: MultipartPartContent;
}

export type RequestBody =
  | { type: 'json'; value: FixtureValue }
  | { type: 'multipart'; parts: MultipartPart[] }
  | { type: 'raw'; content: BytesValue }
  | { type: 'empty' };

export interface FixtureRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: RequestBody;
}

export type ResponseBody =
  | { type: 'json'; value: FixtureValue }
  | { type: 'text'; value: string }
  | { type: 'sse_stream'; chunks: string[] }
  | { type: 'raw'; content: BytesValue }
  | { type: 'empty' };

export interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  body?: ResponseBody;
}

export interface FixtureSdkCall {
  method: string;
  args?: FixtureValue[];
  client_config?: Record<string, FixtureValue>;
}

export interface FixtureWebhook {
  secret: string;
  body: string;
  header_name?: string;
  header_format?: string;
  expected_signature_hex: string;
  algorithm?: 'hmac-sha256';
}

export interface Fixture {
  name: string;
  description?: string;
  mode: FixtureMode;
  sdk: FixtureSdkCall;
  requests: FixtureRequest[];
  responses: FixtureResponse[];
  expected_return?: FixtureValue;
  webhook?: FixtureWebhook;
  // When true, the SDK is expected to throw. Request parity still runs so
  // error paths can assert the outbound call was well-formed; the return
  // value / thrown shape is not compared (captured but unchecked).
  expects_error?: boolean;

  // Meta — not part of the schema; used by the runner.
  __file: string;
}

// ---------------------------------------------------------------------------
// Known tokens. Validators accept any of these in string positions.
// ---------------------------------------------------------------------------

// Tokens allowed in string positions in fixture requests. `hex:N` and
// `base64:N` carry a length parameter. `<string>` is a non-empty-string
// wildcard with no other constraint; `<any>` is the same but documents "we
// really don't care" semantics. `<etag>` matches the quoted S3 ETag form.
const TOKEN_PATTERN = /^<(any|string|uuid|iso8601|int|timestamp_unix|etag|hex:\d+|base64:\d+)>$/;

export function isToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Known SDK methods. Used to fail fast on typos in fixtures.
// ---------------------------------------------------------------------------

export const KNOWN_SDK_METHODS: ReadonlySet<string> = new Set([
  'uploadFile',
  'createWorkflow',
  'getWorkflowStatus',
  'waitForWorkflow',
  'getWorkflowDownloads',
  'streamEvents',
  'getCreditsBalance',
  'getCreditsUsage',
  'getMetadata',
  'getSchema',
  'retryOperation',
  'submitContact',
  // Webhook mode invokes verifyWebhook() directly; it is not a GislClient method.
  'verifyWebhook',
]);

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadFixtures(): Fixture[] {
  const dir = resolveParityFixturesDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  return files.map((file) => {
    const fullPath = resolve(dir, file);
    const raw = parseYaml(readFileSync(fullPath, 'utf-8'));
    return validateFixture(raw, fullPath);
  });
}

// ---------------------------------------------------------------------------
// Validation. Fails fast with fixture-file context in the error message so
// authors can find typos in seconds.
// ---------------------------------------------------------------------------

const FIXTURE_KEYS = new Set([
  'name',
  'description',
  'mode',
  'sdk',
  'requests',
  'responses',
  'expected_return',
  'webhook',
  'expects_error',
]);
const SDK_KEYS = new Set(['method', 'args', 'client_config']);
const REQUEST_KEYS = new Set(['method', 'path', 'query', 'headers', 'body']);
const RESPONSE_KEYS = new Set(['status', 'headers', 'body']);
const WEBHOOK_KEYS = new Set([
  'secret',
  'body',
  'header_name',
  'header_format',
  'expected_signature_hex',
  'algorithm',
]);

function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  ctx: string,
): void {
  const extras = Object.keys(raw).filter((k) => !allowed.has(k));
  if (extras.length > 0) {
    throw new Error(
      `${ctx} unknown key(s): ${extras.join(', ')}. Allowed: ${[...allowed].sort().join(', ')}. ` +
        `A typo here usually means the field is silently ignored; fail fast so authors notice.`,
    );
  }
}

export function validateFixture(raw: unknown, file: string): Fixture {
  const ctx = `[${basename(file)}]`;
  requireObject(raw, ctx, 'root');
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, FIXTURE_KEYS, ctx);

  const name = requireString(r.name, ctx, 'name');
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`${ctx} name must be lowercase snake_case, got "${name}"`);
  }

  const expectedName = basename(file).replace(/\.ya?ml$/, '');
  if (name !== expectedName) {
    throw new Error(`${ctx} name "${name}" must match filename "${expectedName}"`);
  }

  const mode: FixtureMode = (r.mode as FixtureMode | undefined) ?? 'request_response';
  if (!['request_response', 'sse', 'webhook'].includes(mode)) {
    throw new Error(`${ctx} invalid mode "${r.mode}"`);
  }

  requireObject(r.sdk, ctx, 'sdk');
  const sdk = r.sdk as Record<string, unknown>;
  rejectUnknownKeys(sdk, SDK_KEYS, `${ctx} sdk`);
  const method = requireString(sdk.method, ctx, 'sdk.method');
  if (!KNOWN_SDK_METHODS.has(method)) {
    throw new Error(
      `${ctx} unknown sdk.method "${method}". Known: ${[...KNOWN_SDK_METHODS].join(', ')}`,
    );
  }
  if (sdk.args !== undefined && !Array.isArray(sdk.args)) {
    throw new Error(`${ctx} sdk.args must be an array or omitted`);
  }

  const requests = (r.requests ?? []) as unknown;
  if (!Array.isArray(requests)) {
    throw new Error(`${ctx} requests must be an array`);
  }
  const responses = (r.responses ?? []) as unknown;
  if (!Array.isArray(responses)) {
    throw new Error(`${ctx} responses must be an array`);
  }

  if (mode === 'request_response' || mode === 'sse') {
    if (requests.length === 0) {
      throw new Error(`${ctx} mode=${mode} requires at least one request`);
    }
    if (requests.length !== responses.length) {
      throw new Error(
        `${ctx} requests.length (${requests.length}) must equal responses.length (${responses.length})`,
      );
    }
  }

  requests.forEach((req, i) => validateRequest(req, `${ctx} requests[${i}]`));
  responses.forEach((res, i) => validateResponse(res, `${ctx} responses[${i}]`));

  // Scientific-notation guard: YAML loaders handle `1e10` inconsistently across
  // languages. Reject any number in the fixture that round-trips through
  // JSON.stringify with an 'e'. This catches numeric literals in requests,
  // responses, and expected_return.
  scanForScientificNotation(raw, ctx);

  // expected_return is compared with strict deep-equal — tokens are never
  // honoured there (fixture.schema.json:38). Catching a stray token at load
  // time prevents a silently broken fixture that "passes" only because the
  // observed value happened to resemble the token's intent.
  if (r.expected_return !== undefined) {
    const tokenPaths = scanForTokens(r.expected_return, 'expected_return');
    if (tokenPaths.length > 0) {
      throw new Error(
        `${ctx} expected_return contains token(s) (${tokenPaths.join(', ')}) but tokens are not honoured on the return side — ` +
          `compareValue uses strict deep-equal. Write the concrete expected value instead, or omit expected_return to skip the check.`,
      );
    }
  }

  let webhook: FixtureWebhook | undefined;
  if (mode === 'webhook') {
    if (method !== 'verifyWebhook') {
      throw new Error(
        `${ctx} mode=webhook requires sdk.method="verifyWebhook" (got "${method}"). ` +
          `The webhook path does not route through GislClient and another method name would mislead runner implementers.`,
      );
    }
    requireObject(r.webhook, ctx, 'webhook');
    const w = r.webhook as Record<string, unknown>;
    rejectUnknownKeys(w, WEBHOOK_KEYS, `${ctx} webhook`);
    if (requests.length > 0 || responses.length > 0) {
      throw new Error(
        `${ctx} mode=webhook must not declare requests/responses — verifyWebhook makes no HTTP calls`,
      );
    }
    if (w.algorithm !== undefined && w.algorithm !== 'hmac-sha256') {
      throw new Error(
        `${ctx} webhook.algorithm must be "hmac-sha256" (got "${String(w.algorithm)}"). Other algorithms are unsupported by the current SDK.`,
      );
    }
    webhook = {
      secret: requireString(w.secret, ctx, 'webhook.secret'),
      body: requireString(w.body, ctx, 'webhook.body'),
      header_name: (w.header_name as string | undefined) ?? 'x-gis-signature',
      header_format: (w.header_format as string | undefined) ?? 'sha256={hex}',
      expected_signature_hex: requireString(
        w.expected_signature_hex,
        ctx,
        'webhook.expected_signature_hex',
      ),
      algorithm: (w.algorithm as 'hmac-sha256' | undefined) ?? 'hmac-sha256',
    };
    if (!/^[0-9a-f]{64}$/.test(webhook.expected_signature_hex)) {
      throw new Error(
        `${ctx} webhook.expected_signature_hex must be 64 lowercase hex chars`,
      );
    }
  }

  return {
    name,
    description: r.description as string | undefined,
    mode,
    sdk: {
      method,
      args: (sdk.args as FixtureValue[] | undefined) ?? [],
      client_config: sdk.client_config as Record<string, FixtureValue> | undefined,
    },
    requests: requests as FixtureRequest[],
    responses: responses as FixtureResponse[],
    expected_return: r.expected_return as FixtureValue | undefined,
    webhook,
    expects_error: r.expects_error === true,
    __file: file,
  };
}

function requireObject(value: unknown, ctx: string, field: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${ctx} ${field} must be an object`);
  }
}

function requireString(value: unknown, ctx: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${ctx} ${field} must be a non-empty string`);
  }
  return value;
}

const ALLOWED_METHODS = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);

function validateRequest(raw: unknown, ctx: string): void {
  requireObject(raw, ctx, '');
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, REQUEST_KEYS, ctx);
  const method = requireString(r.method, ctx, 'method');
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(
      `${ctx} method "${method}" is not one of ${[...ALLOWED_METHODS].join('|')}`,
    );
  }
  requireString(r.path, ctx, 'path');
  if (r.headers !== undefined) {
    if (typeof r.headers !== 'object' || r.headers === null) {
      throw new Error(`${ctx} headers must be an object`);
    }
    for (const key of Object.keys(r.headers)) {
      if (key !== key.toLowerCase()) {
        throw new Error(`${ctx} headers must use lowercase keys, got "${key}"`);
      }
    }
  }
  if (r.body !== undefined) {
    requireObject(r.body, ctx, 'body');
    const body = r.body as Record<string, unknown>;
    const type = body.type as string | undefined;
    if (!['json', 'multipart', 'raw', 'empty'].includes(type ?? '')) {
      throw new Error(`${ctx} body.type must be one of json|multipart|raw|empty`);
    }
  }
}

function validateResponse(raw: unknown, ctx: string): void {
  requireObject(raw, ctx, '');
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, RESPONSE_KEYS, ctx);
  if (typeof r.status !== 'number' || r.status < 100 || r.status > 599) {
    throw new Error(`${ctx} status must be a number 100-599`);
  }
  if (r.body !== undefined) {
    requireObject(r.body, ctx, 'body');
    const body = r.body as Record<string, unknown>;
    const type = body.type as string | undefined;
    if (!['json', 'text', 'sse_stream', 'raw', 'empty'].includes(type ?? '')) {
      throw new Error(
        `${ctx} body.type must be one of json|text|sse_stream|raw|empty`,
      );
    }
  }
}

function scanForTokens(value: unknown, path: string): string[] {
  if (typeof value === 'string' && isToken(value)) return [`${path}="${value}"`];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => scanForTokens(v, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      scanForTokens(v, `${path}.${k}`),
    );
  }
  return [];
}

function scanForScientificNotation(value: unknown, ctx: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${ctx} non-finite numbers are forbidden in fixtures`);
    }
    const s = JSON.stringify(value);
    if (s.includes('e') || s.includes('E')) {
      throw new Error(
        `${ctx} scientific-notation numbers (${s}) are forbidden — YAML loaders ` +
          `disagree on precision across languages. Write the decimal form instead.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => scanForScientificNotation(v, ctx));
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) {
      scanForScientificNotation(v, ctx);
    }
  }
}
