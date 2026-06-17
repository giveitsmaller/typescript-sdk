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

export type FixtureMode =
  | 'request_response'
  | 'sse'
  | 'webhook'
  | 'local_validation_error'
  | 'lowering'
  // FF2b (tywwynmN) — file-first run-mode execution fixtures.
  | 'run'
  // FF3a (u0hBt6fl) — file-first homogeneous fan-out fixtures.
  | 'files';

/**
 * Fixture schema version. Absent or `'1.0.0'` → v1 (legacy shape); v2
 * blocks (`resolvedOptions`, `omittedFromWire`, `localValidationError`)
 * are rejected. `'2.0.0'` → v2: the v2 blocks are accepted and asserted
 * by the runner. F4-A — `C45ogrGx`.
 */
export type FixtureSchemaVersion = '1.0.0' | '2.0.0';

/**
 * Per-layer field-name buckets the parity comparator asserts against
 * `result.resolvedOptions.sources`. Mirror of `ResolvedOptionsSources`
 * from `packages/typescript/src/builder.ts` (T4b). NOT asserting on the
 * deprecated `overrides[]` field — TS aliases it to `sources.explicit`
 * but PHP keeps it empty (TS/PHP divergence; karen F4 #8).
 */
export interface FixtureResolvedOptionsSources {
  readonly sdkDefault: readonly string[];
  readonly clientDefault: readonly string[];
  readonly scopedDefault: readonly string[];
  readonly callPresetOverride: readonly string[];
  readonly explicit: readonly string[];
}

/**
 * v2 assertion block: expected `result.resolvedOptions` shape for the
 * compress-op chain ending in `.run()` / `.submit()`. F4-A — declared
 * by fixtures with `fixtureSchemaVersion: '2.0.0'`.
 *
 * `presetConfigHash`: when expected to be present, fixtures write
 * `'<sha256>'` — the runner regex-matches the actual value against
 * `/^sha256:[0-9a-f]{64}$/` (presence + format; content is content-
 * derived). When `null`, the comparator asserts the field is absent.
 */
export interface FixtureResolvedOptions {
  readonly preset: string | null;
  readonly applied: Record<string, FixtureValue>;
  readonly sources: FixtureResolvedOptionsSources;
  readonly presetVersion: string;
  readonly presetConfigHash?: string | null;
}

/**
 * v2 assertion block: shape of a `GislConfigError` the SDK threw
 * BEFORE any HTTP call. Fixtures using this block declare
 * `mode: 'local_validation_error'` (which permits zero requests +
 * zero responses, sidestepping the length-pair check).
 *
 * Maps to the augmented `GislConfigError` from T4b — `reason` lines
 * up with `code` here; `conflictingFields` matches directly.
 */
export interface FixtureLocalValidationError {
  readonly category: 'validation' | 'config';
  readonly code: string;
  readonly conflictingFields?: readonly string[];
  readonly message?: string;
}

/**
 * FF2a (`MfV0PDok`) — file-first builder-chain LOWERING spec. The runner
 * builds a `Recipe` from this block, applies each op in order, and lowers it
 * against `resolvedFileId`; the wire payload is deep-compared to
 * `expected_payload`. Network-free (no requests/responses). Requires
 * `fixtureSchemaVersion: '2.0.0'`.
 */
export interface FixtureLoweringFile {
  readonly kind: 'path' | 'upload_id';
  readonly path?: string;
  readonly uploadId?: string;
  readonly key?: string | null;
}

export interface FixtureLoweringOp {
  readonly op: 'compress' | 'convert' | 'thumbnail' | 'text_watermark';
  readonly optimize?: string;
  readonly format?: string;
  readonly width?: number;
  readonly height?: number;
  readonly text?: string;
}

/**
 * FF4a (`Z7zTr789`) — watermark overlay sub-block on a `lowering` fixture. The
 * `overlay` is a secondary file-NODE (its own file + resolved id + optional own
 * steps); `options` are the wire watermark options; `post` are the
 * post-watermark ops (compress/convert/thumbnail ONLY — text_watermark rejected).
 * When present, the base `operations` (preceding steps) MAY be empty.
 */
export interface FixtureWatermarkOverlay {
  readonly file: FixtureLoweringFile;
  readonly resolvedFileId: string;
  readonly operations?: readonly FixtureLoweringOp[];
}
export interface FixtureWatermark {
  readonly overlay: FixtureWatermarkOverlay;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly post?: readonly FixtureLoweringOp[];
}

export interface FixtureLowering {
  readonly file: FixtureLoweringFile;
  readonly resolvedFileId: string;
  readonly operations: readonly FixtureLoweringOp[];
  /** FF4a — when present, this lowers a `file(base).watermark(overlay, opts)`. */
  readonly watermark?: FixtureWatermark;
}

/**
 * FF2b (`tywwynmN`) — file-first run-mode block. Drives
 * `client.file(path).op()...run()` against the fixture's mocked responses
 * and asserts the hydrated RunResult DATA shape (`expected_run_result`).
 * Reuses {@link FixtureLoweringFile} + {@link FixtureLoweringOp} for the
 * file + operation grammar.
 */
export interface FixtureRun {
  readonly file: FixtureLoweringFile;
  readonly operations: readonly FixtureLoweringOp[];
  readonly maxWait?: string | number;
  readonly pollIntervalMs?: number;
}

/**
 * FF5b (`u8M49LU2`) — file-first SUBMIT block. Drives
 * `client.file(...).op()...submit(webhook?)` against the fixture's mocked
 * responses through the STANDARD request_response flow (so `compareRequests`
 * runs and can assert the create request's `callback_url`), then asserts the
 * returned Handle via `expected_return`. Reuses {@link FixtureLoweringFile} +
 * {@link FixtureLoweringOp} for the file + operation grammar; `webhook` is the
 * optional `submit()` argument wired into `callback_url`.
 */
export interface FixtureSubmit {
  readonly file: FixtureLoweringFile;
  readonly operations: readonly FixtureLoweringOp[];
  readonly webhook?: string;
}

/**
 * FF3a (`u0hBt6fl`) — file-first HOMOGENEOUS FAN-OUT block. Builds a
 * `FilesRecipe` from the ORDERED `files[]` input list, applies each shared
 * {@link FixtureLoweringOp} to the chain, then EITHER lowers against
 * `resolvedFileIds` (lowering variant — asserted via `expected_payload`) or
 * drives `.run()` against the canned responses (run variant — asserted via
 * `expected_run_result`). The per-file partition key is the 0-based index.
 * Reuses {@link FixtureLoweringFile} + {@link FixtureLoweringOp} for the
 * per-input + operation grammar.
 */
/**
 * aQMm5khm — file-first `files([...]).merge(opts).<postOp>*` COMBINE sub-block.
 * When present on a {@link FixtureFiles} lowering variant, the runner builds a
 * `FilesRecipe`, calls `.merge(options)` to transition to a `MergedRecipe`, then
 * applies each `operations` entry as a POST-COMBINE op on the merged output
 * before lowering. `options` is the merge-level {@link
 * import('../../src/merge.js').MergeOptions} map (the SAME camelCase keys the
 * operation-first `client.merge(assets, options)` accepts); omit it for a bare
 * merge with no merge-level options. Lowering-variant only (run/submit merge is
 * out of scope — see the card).
 */
export interface FixtureFilesMerge {
  readonly options?: Record<string, FixtureValue>;
}

export interface FixtureFiles {
  readonly files: readonly FixtureLoweringFile[];
  readonly resolvedFileIds?: readonly string[];
  readonly operations: readonly FixtureLoweringOp[];
  // aQMm5khm — presence switches the lowering variant to the merge-combine path
  // (FilesRecipe.merge() -> MergedRecipe -> post-combine ops). `operations` are
  // then the POST-COMBINE ops (and MAY be empty for a bare merge).
  readonly merge?: FixtureFilesMerge;
  readonly maxWait?: string | number;
  readonly pollIntervalMs?: number;
  // uUnCtVAr (FF3a-submit): when present, the files fixture is a fire-and-forget
  // `FilesRecipe.submit(webhook?)` (NOT run/lowering) — the runner drives submit
  // against the canned responses, asserts the create `callback_url` request, and
  // compares the returned Handle via `expected_return`. The submit variant is
  // selected by the PRESENCE of this key, so it must be a NON-EMPTY string (an
  // empty string is rejected by the loader — there is no "submit without
  // webhook" parity fixture, since the whole point is asserting callback_url).
  readonly webhook?: string;
}

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

  // F4-A (C45ogrGx) v2 fields — only valid when `fixtureSchemaVersion`
  // is '2.0.0'. Absent on v1 fixtures (the rejection set at line below
  // refuses them on v1 to keep the discriminated-variant intent).
  fixtureSchemaVersion?: FixtureSchemaVersion;
  resolvedOptions?: FixtureResolvedOptions;
  omittedFromWire?: readonly string[];
  localValidationError?: FixtureLocalValidationError;

  // FF2a (MfV0PDok) — file-first builder-chain lowering (mode='lowering').
  lowering?: FixtureLowering;
  expected_payload?: FixtureValue;

  // FF2b (tywwynmN) — file-first run-mode execution (mode='run'). The runner
  // drives the recipe through .run() against the mocked responses and asserts
  // the hydrated RunResult DATA shape (expected_run_result).
  run?: FixtureRun;
  expected_run_result?: FixtureValue;

  // FF5b (u8M49LU2) — file-first submit (request_response mode, method='file').
  // The runner drives the recipe through .submit(webhook?) against the mocked
  // responses; compareRequests asserts the create callback_url and the returned
  // Handle is compared via expected_return.
  submit?: FixtureSubmit;

  // FF3a (u0hBt6fl) — file-first homogeneous fan-out (mode='files'). The runner
  // builds a FilesRecipe from the files block then EITHER lowers it (asserting
  // expected_payload) or drives .run() (asserting the partitioned
  // expected_run_result), keyed by which assertion key is present.
  files?: FixtureFiles;

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
  'cancelWorkflow',
  'createExternalImport',
  'createWorkflow',
  'decodeAudioWatermark',
  'getWorkflowStatus',
  'resumeWorkflow',
  'waitForWorkflow',
  'getWorkflowDownloads',
  'streamEvents',
  'getCreditsBalance',
  'getCreditsUsage',
  'getMetadata',
  'getSchema',
  'login',
  'logout',
  'preflightClips',
  'probeUpload',
  'retryOperation',
  'submitContact',
  // SDK-3 (Wb6ebOMM) resume-support endpoints.
  'getUploadStatus',
  'presignParts',
  'keepaliveUpload',
  // Webhook mode invokes verifyWebhook() directly; it is not a GislClient method.
  'verifyWebhook',
  // Ergonomic-facade verbs (PHP P2 / 7QXkzoIi symmetric addition). Dispatched
  // through `OperationBuilder` (`packages/typescript/src/builder.ts`); the
  // parity shim at `invoke.ts` constructs the ergonomic client and routes
  // the fixture-defined terminal (`run` / `submit`) through it.
  // `merge` was added in PHP P3 (dxIeLVbP) via a multi-input dispatch
  // path mirrored on the TS side. `watermark` / `archive` / `mapEach`
  // / `bundle` remain UNLISTED:
  //
  //   - `watermark`: v2 OperationType has no bare `watermark` value
  //     (split into image_watermark/text_watermark); needs a preset-style
  //     mapping. Codex caught this gap in PHP P2 review.
  //   - `archive`: contract-modeled as multi-input (`inputs[]`),
  //     incompatible with the single-input `OperationBuilder`. Lands
  //     with P4's `.bundle()` archive sugar.
  //   - `mapEach` / `bundle` land in P4.
  'compress',
  'thumbnail',
  'convert',
  'merge',
  // File-first builder-chain LOWERING marker (FF2a / MfV0PDok). Not a
  // GislClient method — mode=lowering dispatches off the `lowering` block.
  'file',
  // File-first homogeneous fan-out marker (FF3a / u0hBt6fl). Not a GislClient
  // method — mode=files dispatches off the `files` block.
  'files',
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

// v1 fixtures (no `fixtureSchemaVersion` or `fixtureSchemaVersion: '1.0.0'`)
// reject any of the v2 assertion-block keys — preserves discriminated-
// variant semantics. `fixtureSchemaVersion` itself is permitted on v1
// fixtures (explicit `'1.0.0'` is legal) but the v2-only block keys
// stay locked behind a real v2 declaration.
const FIXTURE_KEYS_V1 = new Set([
  'name',
  'description',
  'mode',
  'sdk',
  'requests',
  'responses',
  'expected_return',
  'webhook',
  'expects_error',
  'fixtureSchemaVersion',
]);
// v2 fixtures (`fixtureSchemaVersion: '2.0.0'`) accept the v1 keys plus
// the four v2 assertion-block keys.
const FIXTURE_KEYS_V2 = new Set([
  ...FIXTURE_KEYS_V1,
  'fixtureSchemaVersion',
  'resolvedOptions',
  'omittedFromWire',
  'localValidationError',
  // FF2a (MfV0PDok) — file-first lowering blocks.
  'lowering',
  'expected_payload',
  // FF2b (tywwynmN) — file-first run-mode blocks.
  'run',
  'expected_run_result',
  // FF5b (u8M49LU2) — file-first submit block (request_response mode).
  'submit',
  // FF3a (u0hBt6fl) — file-first homogeneous fan-out block.
  'files',
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

  // Schema-version-discriminated unknown-key rejection (F4-A — C45ogrGx,
  // architect adjustment 2). v2 keys are illegal on v1 fixtures so a typo
  // in a v1 fixture (e.g. `omittedFromWire: …` without bumping the schema
  // version) still fails fast.
  const schemaVersionRaw = r.fixtureSchemaVersion;
  if (schemaVersionRaw !== undefined && schemaVersionRaw !== '1.0.0' && schemaVersionRaw !== '2.0.0') {
    throw new Error(
      `${ctx} fixtureSchemaVersion must be '1.0.0' or '2.0.0', got ${JSON.stringify(schemaVersionRaw)}`,
    );
  }
  const schemaVersion: FixtureSchemaVersion = (schemaVersionRaw as FixtureSchemaVersion | undefined) ?? '1.0.0';
  rejectUnknownKeys(
    r,
    schemaVersion === '2.0.0' ? FIXTURE_KEYS_V2 : FIXTURE_KEYS_V1,
    ctx,
  );

  const name = requireString(r.name, ctx, 'name');
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`${ctx} name must be lowercase snake_case, got "${name}"`);
  }

  const expectedName = basename(file).replace(/\.ya?ml$/, '');
  if (name !== expectedName) {
    throw new Error(`${ctx} name "${name}" must match filename "${expectedName}"`);
  }

  const mode: FixtureMode = (r.mode as FixtureMode | undefined) ?? 'request_response';
  if (
    ![
      'request_response',
      'sse',
      'webhook',
      'local_validation_error',
      'lowering',
      'run',
      'files',
    ].includes(mode)
  ) {
    throw new Error(`${ctx} invalid mode "${r.mode}"`);
  }
  if (mode === 'local_validation_error' && schemaVersion !== '2.0.0') {
    throw new Error(
      `${ctx} mode='local_validation_error' requires fixtureSchemaVersion: '2.0.0'`,
    );
  }
  if (mode === 'lowering' && schemaVersion !== '2.0.0') {
    throw new Error(`${ctx} mode='lowering' requires fixtureSchemaVersion: '2.0.0'`);
  }
  if (mode === 'run' && schemaVersion !== '2.0.0') {
    throw new Error(`${ctx} mode='run' requires fixtureSchemaVersion: '2.0.0'`);
  }
  if (mode === 'files' && schemaVersion !== '2.0.0') {
    throw new Error(`${ctx} mode='files' requires fixtureSchemaVersion: '2.0.0'`);
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
  if (mode === 'local_validation_error') {
    // The SDK throws before any HTTP call lands. Zero requests, zero
    // responses; localValidationError block is mandatory.
    if (requests.length !== 0 || responses.length !== 0) {
      throw new Error(
        `${ctx} mode=local_validation_error must declare zero requests + zero responses (got ${requests.length}/${responses.length})`,
      );
    }
    if (r.localValidationError === undefined) {
      throw new Error(
        `${ctx} mode=local_validation_error requires a localValidationError block`,
      );
    }
  }
  if (mode === 'lowering') {
    if (requests.length !== 0 || responses.length !== 0) {
      throw new Error(
        `${ctx} mode=lowering must declare zero requests + zero responses (lowering is network-free)`,
      );
    }
    if (method !== 'file') {
      throw new Error(`${ctx} mode=lowering requires sdk.method="file" (got "${method}")`);
    }
    if (r.lowering === undefined || r.expected_payload === undefined) {
      throw new Error(
        `${ctx} mode=lowering requires both a lowering block and an expected_payload block`,
      );
    }
  }
  if (mode === 'run') {
    // FF2b (tywwynmN) — run-mode declares the mocked upload/create/terminal/
    // downloads `responses` but NO `requests` assertions (wire parity is
    // covered by mode=lowering + the low-level method fixtures; run-mode pins
    // the hydrated RunResult).
    if (requests.length !== 0) {
      throw new Error(
        `${ctx} mode=run must declare zero requests (it asserts the hydrated RunResult, not wire requests)`,
      );
    }
    if (method !== 'file') {
      throw new Error(`${ctx} mode=run requires sdk.method="file" (got "${method}")`);
    }
    if (r.run === undefined || r.expected_run_result === undefined) {
      throw new Error(
        `${ctx} mode=run requires both a run block and an expected_run_result block`,
      );
    }
  }
  if (mode === 'files') {
    // FF3a (u0hBt6fl) — homogeneous fan-out. The lowering/run variants declare
    // the mocked `responses` but NO `requests`; the uUnCtVAr SUBMIT variant
    // (files.webhook) DOES declare requests (the create callback_url
    // assertion). Asserts EXACTLY ONE of expected_payload (lowering — zero
    // responses) / expected_run_result (run) / expected_return+requests
    // (submit), discriminated below.
    if (method !== 'files') {
      throw new Error(`${ctx} mode=files requires sdk.method="files" (got "${method}")`);
    }
    if (r.files === undefined) {
      throw new Error(`${ctx} mode=files requires a files block`);
    }
    // aQMm5khm — the merge-combine path is LOWERING-ONLY (run/submit merge is
    // out of scope). Reject `files.merge` on any non-lowering variant (run =
    // expected_run_result, submit = files.webhook) so a misplaced merge block
    // can't silently no-op — runFilesFixture/submitFilesFixture build a plain
    // FilesRecipe and would ignore `spec.merge` entirely.
    if (
      (r.files as Record<string, unknown>).merge !== undefined &&
      r.expected_payload === undefined
    ) {
      throw new Error(
        `${ctx} files.merge is only supported in the lowering variant (expected_payload); a run/submit mode=files fixture cannot carry a merge block`,
      );
    }
    // uUnCtVAr (FF3a-submit): a `files.webhook` marks the SUBMIT variant —
    // it drives FilesRecipe.submit() and asserts the create `callback_url`
    // request + the returned Handle (expected_return), NOT a lowering/run
    // payload. The lowering/run variants are unchanged.
    const filesWebhook = (r.files as Record<string, unknown>).webhook;
    const isFilesSubmit = filesWebhook !== undefined;
    if (isFilesSubmit) {
      if (typeof filesWebhook !== 'string' || filesWebhook === '') {
        throw new Error(
          `${ctx} mode=files files.webhook must be a non-empty string (the submit-variant callback_url)`,
        );
      }
      if (r.expected_payload !== undefined || r.expected_run_result !== undefined) {
        throw new Error(
          `${ctx} mode=files submit variant (files.webhook) must NOT declare expected_payload/expected_run_result — assert the create request + expected_return instead`,
        );
      }
      if (requests.length === 0) {
        throw new Error(
          `${ctx} mode=files submit variant requires at least one request (the create callback_url assertion)`,
        );
      }
      if (r.expected_return === undefined) {
        throw new Error(
          `${ctx} mode=files submit variant requires expected_return (the returned Handle assertion)`,
        );
      }
    } else {
      if (requests.length !== 0) {
        throw new Error(
          `${ctx} mode=files (lowering/run variant) must declare zero requests (it asserts the lowered payload or the partitioned RunResult, not wire requests)`,
        );
      }
      const hasPayload = r.expected_payload !== undefined;
      const hasRunResult = r.expected_run_result !== undefined;
      if (hasPayload === hasRunResult) {
        throw new Error(
          `${ctx} mode=files requires EXACTLY ONE of expected_payload (lowering variant) or expected_run_result (run variant)`,
        );
      }
      if (hasPayload && responses.length !== 0) {
        throw new Error(
          `${ctx} mode=files lowering variant (expected_payload) must declare zero responses (lowering is network-free)`,
        );
      }
    }
  }
  // FF5b (u8M49LU2) — a `submit` block routes a file-first chain through the
  // STANDARD request_response flow (so compareRequests can assert the create
  // callback_url). It is therefore gated to request_response mode + method:file,
  // and (like every request_response fixture) declares matching requests +
  // responses; the length-pair check above already enforces that.
  if (r.submit !== undefined) {
    if (mode !== 'request_response') {
      throw new Error(
        `${ctx} a submit block requires the default request_response mode (got mode="${mode}"); ` +
          `mode=run forbids a requests block and cannot assert the create callback_url`,
      );
    }
    if (method !== 'file') {
      throw new Error(`${ctx} a submit block requires sdk.method="file" (got "${method}")`);
    }
    if (schemaVersion !== '2.0.0') {
      throw new Error(`${ctx} a submit block requires fixtureSchemaVersion: '2.0.0'`);
    }
  } else if (method === 'file' && mode === 'request_response') {
    // method:file in request_response mode with NO submit block has no dispatch.
    throw new Error(
      `${ctx} sdk.method="file" in request_response mode requires a submit block (FF5b). ` +
        `Use mode=lowering / mode=run for the other file-first dispatches.`,
    );
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

  // F4-A v2 block validation. Each block runs ONLY when present + schema
  // version is '2.0.0' (rejection set already enforces that v2 keys
  // can't appear on a v1 fixture).
  let resolvedOptions: FixtureResolvedOptions | undefined;
  if (r.resolvedOptions !== undefined) {
    resolvedOptions = validateResolvedOptions(r.resolvedOptions, `${ctx} resolvedOptions`);
  }
  let omittedFromWire: readonly string[] | undefined;
  if (r.omittedFromWire !== undefined) {
    if (!Array.isArray(r.omittedFromWire) || !r.omittedFromWire.every((s) => typeof s === 'string')) {
      throw new Error(`${ctx} omittedFromWire must be an array of strings`);
    }
    omittedFromWire = [...(r.omittedFromWire as string[])];
  }
  let localValidationError: FixtureLocalValidationError | undefined;
  if (r.localValidationError !== undefined) {
    localValidationError = validateLocalValidationError(
      r.localValidationError,
      `${ctx} localValidationError`,
    );
  }
  let lowering: FixtureLowering | undefined;
  if (r.lowering !== undefined) {
    lowering = validateLowering(r.lowering, `${ctx} lowering`);
  }
  // FF2b (tywwynmN) — run-mode block.
  let run: FixtureRun | undefined;
  if (r.run !== undefined) {
    run = validateRun(r.run, `${ctx} run`);
  }
  // FF5b (u8M49LU2) — submit block.
  let submit: FixtureSubmit | undefined;
  if (r.submit !== undefined) {
    submit = validateSubmit(r.submit, `${ctx} submit`);
  }
  // FF3a (u0hBt6fl) — files block.
  let files: FixtureFiles | undefined;
  if (r.files !== undefined) {
    files = validateFiles(r.files, `${ctx} files`);
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
    ...(schemaVersion !== '1.0.0' ? { fixtureSchemaVersion: schemaVersion } : {}),
    ...(resolvedOptions !== undefined ? { resolvedOptions } : {}),
    ...(omittedFromWire !== undefined ? { omittedFromWire } : {}),
    ...(localValidationError !== undefined ? { localValidationError } : {}),
    ...(lowering !== undefined ? { lowering } : {}),
    ...(r.expected_payload !== undefined ? { expected_payload: r.expected_payload as FixtureValue } : {}),
    // FF2b (tywwynmN) — run-mode block + expected hydrated RunResult shape.
    ...(run !== undefined ? { run } : {}),
    ...(r.expected_run_result !== undefined
      ? { expected_run_result: r.expected_run_result as FixtureValue }
      : {}),
    // FF5b (u8M49LU2) — submit block.
    ...(submit !== undefined ? { submit } : {}),
    // FF3a (u0hBt6fl) — files block.
    ...(files !== undefined ? { files } : {}),
    __file: file,
  };
}

const LOWERING_OPS = new Set(['compress', 'convert', 'thumbnail', 'text_watermark']);
const LOWERING_KEYS = new Set(['file', 'resolvedFileId', 'operations', 'watermark']);
const LOWERING_FILE_KEYS = new Set(['kind', 'path', 'uploadId', 'key']);
const LOWERING_OP_KEYS = new Set(['op', 'optimize', 'format', 'width', 'height', 'text']);
// FF4a (Z7zTr789) — watermark sub-block keys + post-op grammar (no text_watermark).
const WATERMARK_KEYS = new Set(['overlay', 'options', 'post']);
const WATERMARK_OVERLAY_KEYS = new Set(['file', 'resolvedFileId', 'operations']);
const WATERMARK_POST_OPS = new Set(['compress', 'convert', 'thumbnail']);
// FF2b (tywwynmN) — run-mode block keys: lowering's file + operations plus the
// run-only maxWait / pollIntervalMs.
const RUN_KEYS = new Set(['file', 'operations', 'maxWait', 'pollIntervalMs']);
// FF5b (u8M49LU2) — submit block keys: lowering's file + operations plus the
// submit-only optional webhook.
const SUBMIT_KEYS = new Set(['file', 'operations', 'webhook']);
// FF3a (u0hBt6fl) — files block keys: an ordered files[] input list +
// operations + (lowering variant) resolvedFileIds + (run variant) maxWait /
// pollIntervalMs.
const FILES_KEYS = new Set([
  'files',
  'resolvedFileIds',
  'operations',
  // aQMm5khm — merge-combine sub-block.
  'merge',
  'maxWait',
  'pollIntervalMs',
  'webhook',
]);
// aQMm5khm — keys allowed inside a `files.merge` sub-block.
const FILES_MERGE_KEYS = new Set(['options']);
// aQMm5khm — allowed `files.merge.options` keys (the camelCase MergeOptions
// fields both runners read). Rejecting unknowns at load time stops a typo'd or
// snake_case key (e.g. `gap_duration` for `gapDuration`) from being silently
// dropped by wireMergeOptions, which would leave the fixture passing with the
// wrong wire shape. Keep in sync with the MergeOptions interface (merge.ts) +
// the PHP loader's FILES_MERGE_OPTION_KEYS.
const FILES_MERGE_OPTION_KEYS = new Set([
  'transition',
  'crossfadeDuration',
  'gapDuration',
  'normalizeAudio',
  'codec',
  'crf',
  'preset',
  'targetSize',
  'transitionDuration',
  'fps',
  'durationPerImage',
  'loopCount',
  'output',
  'videoFormat',
  'outputType',
  'mediaKind',
  'allowUnusedAssets',
]);

/**
 * FF2b — validate the `run` block. Reuses the lowering `file` + op-param
 * validators (the chain grammar is identical) and adds the run-only `maxWait` /
 * `pollIntervalMs` keys. Mirrors the PHP `FixtureLoader::validateRun`.
 */
function validateRun(value: unknown, ctx: string): FixtureRun {
  requireObject(value, ctx, '(root)');
  const v = value as Record<string, unknown>;
  rejectUnknownKeys(v, RUN_KEYS, ctx);

  requireObject(v.file, ctx, 'file');
  const file = v.file as Record<string, unknown>;
  rejectUnknownKeys(file, LOWERING_FILE_KEYS, `${ctx} file`);
  const kind = file.kind;
  if (kind !== 'path' && kind !== 'upload_id') {
    throw new Error(`${ctx} file.kind must be 'path' or 'upload_id'`);
  }
  if (kind === 'path' && (typeof file.path !== 'string' || file.path === '')) {
    throw new Error(`${ctx} file.path must be a non-empty string when kind=path`);
  }
  if (kind === 'upload_id' && (typeof file.uploadId !== 'string' || file.uploadId === '')) {
    throw new Error(`${ctx} file.uploadId must be a non-empty string when kind=upload_id`);
  }

  if (!Array.isArray(v.operations) || v.operations.length === 0) {
    throw new Error(`${ctx} operations must be a non-empty array`);
  }
  const operations = v.operations.map((op, i): FixtureLoweringOp => {
    requireObject(op, ctx, `operations[${i}]`);
    const o = op as Record<string, unknown>;
    rejectUnknownKeys(o, LOWERING_OP_KEYS, `${ctx} operations[${i}]`);
    if (typeof o.op !== 'string' || !LOWERING_OPS.has(o.op)) {
      throw new Error(`${ctx} operations[${i}].op must be one of ${[...LOWERING_OPS].join('|')}`);
    }
    validateLoweringOpParams(o.op, o, `${ctx} operations[${i}]`);
    return o as unknown as FixtureLoweringOp;
  });

  if (v.maxWait !== undefined && typeof v.maxWait !== 'string' && typeof v.maxWait !== 'number') {
    throw new Error(`${ctx} maxWait must be a string or number when present`);
  }
  if (v.pollIntervalMs !== undefined && !Number.isInteger(v.pollIntervalMs)) {
    throw new Error(`${ctx} pollIntervalMs must be an integer when present`);
  }

  const result: FixtureRun = {
    file: file as unknown as FixtureLoweringFile,
    operations,
    ...(v.maxWait !== undefined ? { maxWait: v.maxWait as string | number } : {}),
    ...(v.pollIntervalMs !== undefined ? { pollIntervalMs: v.pollIntervalMs as number } : {}),
  };
  return result;
}

/**
 * FF5b — validate the `submit` block. Reuses the lowering `file` + op-param
 * validators (the chain grammar is identical) and adds the submit-only optional
 * `webhook` string. Mirrors the PHP `FixtureLoader::validateSubmit`.
 */
function validateSubmit(value: unknown, ctx: string): FixtureSubmit {
  requireObject(value, ctx, '(root)');
  const v = value as Record<string, unknown>;
  rejectUnknownKeys(v, SUBMIT_KEYS, ctx);

  requireObject(v.file, ctx, 'file');
  const file = v.file as Record<string, unknown>;
  rejectUnknownKeys(file, LOWERING_FILE_KEYS, `${ctx} file`);
  const kind = file.kind;
  if (kind !== 'path' && kind !== 'upload_id') {
    throw new Error(`${ctx} file.kind must be 'path' or 'upload_id'`);
  }
  if (kind === 'path' && (typeof file.path !== 'string' || file.path === '')) {
    throw new Error(`${ctx} file.path must be a non-empty string when kind=path`);
  }
  if (kind === 'upload_id' && (typeof file.uploadId !== 'string' || file.uploadId === '')) {
    throw new Error(`${ctx} file.uploadId must be a non-empty string when kind=upload_id`);
  }

  if (!Array.isArray(v.operations) || v.operations.length === 0) {
    throw new Error(`${ctx} operations must be a non-empty array`);
  }
  const operations = v.operations.map((op, i): FixtureLoweringOp => {
    requireObject(op, ctx, `operations[${i}]`);
    const o = op as Record<string, unknown>;
    rejectUnknownKeys(o, LOWERING_OP_KEYS, `${ctx} operations[${i}]`);
    if (typeof o.op !== 'string' || !LOWERING_OPS.has(o.op)) {
      throw new Error(`${ctx} operations[${i}].op must be one of ${[...LOWERING_OPS].join('|')}`);
    }
    validateLoweringOpParams(o.op, o, `${ctx} operations[${i}]`);
    return o as unknown as FixtureLoweringOp;
  });

  if (v.webhook !== undefined && (typeof v.webhook !== 'string' || v.webhook === '')) {
    throw new Error(`${ctx} webhook must be a non-empty string when present`);
  }

  const result: FixtureSubmit = {
    file: file as unknown as FixtureLoweringFile,
    operations,
    ...(v.webhook !== undefined ? { webhook: v.webhook as string } : {}),
  };
  return result;
}

/**
 * FF3a — validate the `files` block. Reuses the lowering `file` + op-param
 * validators PER ENTRY (the per-input + chain grammar is identical) and adds
 * the fan-out-only `resolvedFileIds` (lowering variant) + run-only `maxWait` /
 * `pollIntervalMs`. Mirrors the PHP `FixtureLoader::validateFiles`.
 */
function validateFiles(value: unknown, ctx: string): FixtureFiles {
  requireObject(value, ctx, '(root)');
  const v = value as Record<string, unknown>;
  rejectUnknownKeys(v, FILES_KEYS, ctx);

  if (!Array.isArray(v.files) || v.files.length === 0) {
    throw new Error(`${ctx} files must be a non-empty array of file inputs`);
  }
  const inputs = v.files.map((entry, i): FixtureLoweringFile => {
    requireObject(entry, ctx, `files[${i}]`);
    const f = entry as Record<string, unknown>;
    rejectUnknownKeys(f, LOWERING_FILE_KEYS, `${ctx} files[${i}]`);
    const kind = f.kind;
    if (kind !== 'path' && kind !== 'upload_id') {
      throw new Error(`${ctx} files[${i}].kind must be 'path' or 'upload_id'`);
    }
    if (kind === 'path' && (typeof f.path !== 'string' || f.path === '')) {
      throw new Error(`${ctx} files[${i}].path must be a non-empty string when kind=path`);
    }
    if (kind === 'upload_id' && (typeof f.uploadId !== 'string' || f.uploadId === '')) {
      throw new Error(`${ctx} files[${i}].uploadId must be a non-empty string when kind=upload_id`);
    }
    return f as unknown as FixtureLoweringFile;
  });

  let resolvedFileIds: readonly string[] | undefined;
  if (v.resolvedFileIds !== undefined) {
    if (
      !Array.isArray(v.resolvedFileIds) ||
      !v.resolvedFileIds.every((s) => typeof s === 'string' && s !== '')
    ) {
      throw new Error(`${ctx} resolvedFileIds must be an array of non-empty strings`);
    }
    if (v.resolvedFileIds.length !== inputs.length) {
      throw new Error(
        `${ctx} resolvedFileIds length (${v.resolvedFileIds.length}) must equal files length (${inputs.length}) — one resolved id per input`,
      );
    }
    resolvedFileIds = [...(v.resolvedFileIds as string[])];
  }

  // aQMm5khm — a `merge` sub-block switches the lowering variant to the
  // merge-combine path; `operations` then carry the POST-COMBINE ops and MAY
  // be empty (a bare merge). Without it, `operations` are the shared fan-out
  // chain and stay non-empty (FF3a).
  let merge: FixtureFilesMerge | undefined;
  if (v.merge !== undefined) {
    requireObject(v.merge, ctx, 'merge');
    const m = v.merge as Record<string, unknown>;
    rejectUnknownKeys(m, FILES_MERGE_KEYS, `${ctx} merge`);
    if (m.options !== undefined) {
      requireObject(m.options, ctx, 'merge.options');
      rejectUnknownKeys(m.options as Record<string, unknown>, FILES_MERGE_OPTION_KEYS, `${ctx} merge.options`);
    }
    // NOTE: the merge-combine path is LOWERING-ONLY (run/submit merge is out of
    // scope). The "merge requires the expected_payload lowering variant" guard
    // lives in the mode=files discriminator (validateFixture), where
    // expected_payload / expected_run_result / webhook are all visible — here
    // in validateFiles only the files block is in scope.
    merge = m.options !== undefined ? { options: m.options as Record<string, FixtureValue> } : {};
  }

  if (!Array.isArray(v.operations) || (merge === undefined && v.operations.length === 0)) {
    throw new Error(
      `${ctx} operations must be ${merge === undefined ? 'a non-empty array' : 'an array (may be empty for a bare merge)'}`,
    );
  }
  const operations = v.operations.map((op, i): FixtureLoweringOp => {
    requireObject(op, ctx, `operations[${i}]`);
    const o = op as Record<string, unknown>;
    rejectUnknownKeys(o, LOWERING_OP_KEYS, `${ctx} operations[${i}]`);
    if (typeof o.op !== 'string' || !LOWERING_OPS.has(o.op)) {
      throw new Error(`${ctx} operations[${i}].op must be one of ${[...LOWERING_OPS].join('|')}`);
    }
    // text_watermark has no MergedRecipe equivalent (the merged output exposes
    // compress/convert/thumbnail only) — reject it as a post-combine op so the
    // failure is at load time, not a runtime dispatch error.
    if (merge !== undefined && o.op === 'text_watermark') {
      throw new Error(
        `${ctx} operations[${i}].op 'text_watermark' is not a valid post-merge op (MergedRecipe exposes compress/convert/thumbnail only)`,
      );
    }
    validateLoweringOpParams(o.op, o, `${ctx} operations[${i}]`);
    return o as unknown as FixtureLoweringOp;
  });

  if (v.maxWait !== undefined && typeof v.maxWait !== 'string' && typeof v.maxWait !== 'number') {
    throw new Error(`${ctx} maxWait must be a string or number when present`);
  }
  if (v.pollIntervalMs !== undefined && !Number.isInteger(v.pollIntervalMs)) {
    throw new Error(`${ctx} pollIntervalMs must be an integer when present`);
  }
  if (v.webhook !== undefined && typeof v.webhook !== 'string') {
    throw new Error(`${ctx} webhook must be a string when present (submit variant)`);
  }

  return {
    files: inputs,
    ...(resolvedFileIds !== undefined ? { resolvedFileIds } : {}),
    operations,
    ...(merge !== undefined ? { merge } : {}),
    ...(v.maxWait !== undefined ? { maxWait: v.maxWait as string | number } : {}),
    ...(v.pollIntervalMs !== undefined ? { pollIntervalMs: v.pollIntervalMs as number } : {}),
    ...(v.webhook !== undefined ? { webhook: v.webhook as string } : {}),
  };
}

/**
 * FF2a — validate the `lowering` block. Mirrors the PHP `FixtureLoader::
 * validateLowering` so both runners reject the same authoring typos.
 */
function validateLowering(value: unknown, ctx: string): FixtureLowering {
  requireObject(value, ctx, '(root)');
  const v = value as Record<string, unknown>;
  rejectUnknownKeys(v, LOWERING_KEYS, ctx);

  requireObject(v.file, ctx, 'file');
  const file = v.file as Record<string, unknown>;
  rejectUnknownKeys(file, LOWERING_FILE_KEYS, `${ctx} file`);
  const kind = file.kind;
  if (kind !== 'path' && kind !== 'upload_id') {
    throw new Error(`${ctx} file.kind must be 'path' or 'upload_id'`);
  }
  if (kind === 'path' && (typeof file.path !== 'string' || file.path === '')) {
    throw new Error(`${ctx} file.path must be a non-empty string when kind=path`);
  }
  if (kind === 'upload_id' && (typeof file.uploadId !== 'string' || file.uploadId === '')) {
    throw new Error(`${ctx} file.uploadId must be a non-empty string when kind=upload_id`);
  }

  const resolvedFileId = requireString(v.resolvedFileId, ctx, 'resolvedFileId');
  // For a pre-uploaded input the resolved source id IS the upload id — enforce
  // they match so a mismatched fixture can't silently lower against
  // resolvedFileId and mask the wrong intent.
  if (kind === 'upload_id' && file.uploadId !== resolvedFileId) {
    throw new Error(`${ctx} resolvedFileId must equal file.uploadId for kind=upload_id`);
  }

  // FF4a — a `watermark` block makes `operations` the BASE preceding steps,
  // which MAY be empty; a plain chain lowering still requires non-empty ops.
  const hasWatermark = v.watermark !== undefined;
  if (!Array.isArray(v.operations) || (v.operations.length === 0 && !hasWatermark)) {
    throw new Error(`${ctx} operations must be a non-empty array`);
  }
  const operations = v.operations.map((op, i): FixtureLoweringOp => {
    requireObject(op, ctx, `operations[${i}]`);
    const o = op as Record<string, unknown>;
    rejectUnknownKeys(o, LOWERING_OP_KEYS, `${ctx} operations[${i}]`);
    if (typeof o.op !== 'string' || !LOWERING_OPS.has(o.op)) {
      throw new Error(
        `${ctx} operations[${i}].op must be one of ${[...LOWERING_OPS].join('|')}`,
      );
    }
    validateLoweringOpParams(o.op, o, `${ctx} operations[${i}]`);
    return o as unknown as FixtureLoweringOp;
  });

  const result: FixtureLowering = {
    file: file as unknown as FixtureLoweringFile,
    resolvedFileId,
    operations,
    ...(hasWatermark ? { watermark: validateWatermark(v.watermark, `${ctx} watermark`) } : {}),
  };
  return result;
}

/**
 * FF4a (Z7zTr789) — validate the `lowering.watermark` sub-block: the overlay
 * file-node (file + resolvedFileId + optional own ops), the wire options bag,
 * and the post-watermark ops (compress/convert/thumbnail ONLY — text_watermark
 * is rejected, matching the WatermarkedRecipe post-verb set). Mirrors the PHP
 * `FixtureLoader::validateWatermark`.
 */
function validateWatermark(value: unknown, ctx: string): FixtureWatermark {
  requireObject(value, ctx, '(root)');
  const v = value as Record<string, unknown>;
  rejectUnknownKeys(v, WATERMARK_KEYS, ctx);

  requireObject(v.overlay, ctx, 'overlay');
  const ov = v.overlay as Record<string, unknown>;
  rejectUnknownKeys(ov, WATERMARK_OVERLAY_KEYS, `${ctx} overlay`);
  requireObject(ov.file, ctx, 'overlay.file');
  const ofile = ov.file as Record<string, unknown>;
  rejectUnknownKeys(ofile, LOWERING_FILE_KEYS, `${ctx} overlay.file`);
  const okind = ofile.kind;
  if (okind !== 'path' && okind !== 'upload_id') {
    throw new Error(`${ctx} overlay.file.kind must be 'path' or 'upload_id'`);
  }
  if (okind === 'path' && (typeof ofile.path !== 'string' || ofile.path === '')) {
    throw new Error(`${ctx} overlay.file.path must be a non-empty string when kind=path`);
  }
  if (okind === 'upload_id' && (typeof ofile.uploadId !== 'string' || ofile.uploadId === '')) {
    throw new Error(`${ctx} overlay.file.uploadId must be a non-empty string when kind=upload_id`);
  }
  const overlayResolvedFileId = requireString(ov.resolvedFileId, ctx, 'overlay.resolvedFileId');
  if (okind === 'upload_id' && ofile.uploadId !== overlayResolvedFileId) {
    throw new Error(`${ctx} overlay.resolvedFileId must equal overlay.file.uploadId for kind=upload_id`);
  }

  const overlayOps = validateWatermarkOps(ov.operations, LOWERING_OPS, `${ctx} overlay.operations`);
  const post = validateWatermarkOps(v.post, WATERMARK_POST_OPS, `${ctx} post`);

  if (v.options !== undefined) {
    requireObject(v.options, ctx, 'options');
  }

  const overlay: FixtureWatermarkOverlay = {
    file: ofile as unknown as FixtureLoweringFile,
    resolvedFileId: overlayResolvedFileId,
    ...(overlayOps.length > 0 ? { operations: overlayOps } : {}),
  };
  return {
    overlay,
    ...(v.options !== undefined ? { options: v.options as Record<string, unknown> } : {}),
    ...(post.length > 0 ? { post } : {}),
  };
}

/** Validate an optional op array against an allowed-op set (FF4a overlay/post). */
function validateWatermarkOps(
  value: unknown,
  allowed: ReadonlySet<string>,
  ctx: string,
): FixtureLoweringOp[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${ctx} must be an array`);
  }
  return value.map((op, i): FixtureLoweringOp => {
    requireObject(op, ctx, `[${i}]`);
    const o = op as Record<string, unknown>;
    rejectUnknownKeys(o, LOWERING_OP_KEYS, `${ctx}[${i}]`);
    if (typeof o.op !== 'string' || !allowed.has(o.op)) {
      throw new Error(`${ctx}[${i}].op must be one of ${[...allowed].join('|')}`);
    }
    validateLoweringOpParams(o.op, o, `${ctx}[${i}]`);
    return o as unknown as FixtureLoweringOp;
  });
}

/**
 * Validate per-op required params + scalar types so a malformed fixture fails
 * at load instead of dispatching `undefined`/wrong-typed values. Mirrors the
 * PHP `FixtureLoader::validateLoweringOpParams`.
 */
function validateLoweringOpParams(op: string, o: Record<string, unknown>, ctx: string): void {
  switch (op) {
    case 'convert':
      if (typeof o.format !== 'string' || o.format === '') {
        throw new Error(`${ctx} convert requires a non-empty string 'format'`);
      }
      break;
    case 'text_watermark':
      if (typeof o.text !== 'string' || o.text === '') {
        throw new Error(`${ctx} text_watermark requires a non-empty string 'text'`);
      }
      break;
    case 'thumbnail':
      for (const dim of ['width', 'height'] as const) {
        if (dim in o && (!Number.isInteger(o[dim]) || (o[dim] as number) < 1)) {
          throw new Error(`${ctx} thumbnail '${dim}' must be a positive integer`);
        }
      }
      if (!('width' in o) && !('height' in o)) {
        throw new Error(`${ctx} thumbnail requires at least one of width/height`);
      }
      break;
    case 'compress':
      if ('optimize' in o && (typeof o.optimize !== 'string' || o.optimize === '')) {
        throw new Error(`${ctx} compress 'optimize' must be a non-empty string when present`);
      }
      break;
  }
}

function validateResolvedOptions(value: unknown, ctx: string): FixtureResolvedOptions {
  requireObject(value, ctx, '(root)');
  const v = value as Record<string, unknown>;
  const allowed = new Set([
    'preset',
    'applied',
    'sources',
    'presetVersion',
    'presetConfigHash',
  ]);
  rejectUnknownKeys(v, allowed, ctx);

  // `preset` may be a string (OptimizeFor literal) OR null.
  if (v.preset !== null && typeof v.preset !== 'string') {
    throw new Error(`${ctx} preset must be a string or null`);
  }
  requireObject(v.applied, ctx, 'applied');
  requireObject(v.sources, ctx, 'sources');
  const s = v.sources as Record<string, unknown>;
  const sourceKeys = new Set([
    'sdkDefault',
    'clientDefault',
    'scopedDefault',
    'callPresetOverride',
    'explicit',
  ]);
  rejectUnknownKeys(s, sourceKeys, `${ctx} sources`);
  for (const key of sourceKeys) {
    const bucket = s[key];
    if (!Array.isArray(bucket) || !bucket.every((entry) => typeof entry === 'string')) {
      throw new Error(`${ctx} sources.${key} must be an array of strings`);
    }
  }
  if (typeof v.presetVersion !== 'string') {
    throw new Error(`${ctx} presetVersion must be a string`);
  }
  if (v.presetConfigHash !== undefined && v.presetConfigHash !== null) {
    if (typeof v.presetConfigHash !== 'string') {
      throw new Error(`${ctx} presetConfigHash must be a string, null, or omitted`);
    }
  }
  const sources: FixtureResolvedOptionsSources = {
    sdkDefault: [...(s.sdkDefault as string[])],
    clientDefault: [...(s.clientDefault as string[])],
    scopedDefault: [...(s.scopedDefault as string[])],
    callPresetOverride: [...(s.callPresetOverride as string[])],
    explicit: [...(s.explicit as string[])],
  };
  return {
    preset: v.preset as string | null,
    applied: v.applied as Record<string, FixtureValue>,
    sources,
    presetVersion: v.presetVersion as string,
    ...(v.presetConfigHash !== undefined
      ? { presetConfigHash: v.presetConfigHash as string | null }
      : {}),
  };
}

function validateLocalValidationError(
  value: unknown,
  ctx: string,
): FixtureLocalValidationError {
  requireObject(value, ctx, '(root)');
  const v = value as Record<string, unknown>;
  const allowed = new Set(['category', 'code', 'conflictingFields', 'message']);
  rejectUnknownKeys(v, allowed, ctx);
  if (v.category !== 'validation' && v.category !== 'config') {
    throw new Error(`${ctx} category must be 'validation' or 'config'`);
  }
  if (typeof v.code !== 'string' || v.code.length === 0) {
    throw new Error(`${ctx} code must be a non-empty string`);
  }
  let conflictingFields: readonly string[] | undefined;
  if (v.conflictingFields !== undefined) {
    if (
      !Array.isArray(v.conflictingFields) ||
      !v.conflictingFields.every((s) => typeof s === 'string')
    ) {
      throw new Error(`${ctx} conflictingFields must be an array of strings`);
    }
    conflictingFields = [...(v.conflictingFields as string[])];
  }
  let message: string | undefined;
  if (v.message !== undefined) {
    if (typeof v.message !== 'string') {
      throw new Error(`${ctx} message must be a string or omitted`);
    }
    message = v.message;
  }
  return {
    category: v.category as 'validation' | 'config',
    code: v.code as string,
    ...(conflictingFields !== undefined ? { conflictingFields } : {}),
    ...(message !== undefined ? { message } : {}),
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
