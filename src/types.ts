import type {
  OperationType,
  OperationsSchemaResponse,
  OperationCapability,
  OutputProperties,
  ImageEncodeCapabilities,
  CallbackEventType,
  SseEventType,
  SseOperationProgressData,
  SseOperationCompletedData,
  SseOperationFailedData,
  SseJobCompletedData,
  SseJobFailedData,
  SseWorkflowTerminalData,
  MultipartInitiateRequestMetadataHint,
  UploadProbeResponse,
  WorkflowSource,
  MultiInputSource,
} from '@giveitsmaller/contracts/openapi';
import type { JobInputV2RoleEnum, NotifyConfig } from '@giveitsmaller/contracts/openapi';

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

export interface GislClientConfig {
  baseUrl: string;
  /**
   * Host for the **SSE event stream** (`streamEvents`). The stream is served
   * from a SECOND public entry point, separate from `baseUrl`: the API host
   * fronts an integration with no response-streaming mode.
   *
   * Setting this moves the stream and **nothing else** — uploads,
   * workflow-create and downloads keep using `baseUrl`. That is the reason it
   * exists as its own field rather than being expressed by overriding
   * `baseUrl`, which moves every call.
   *
   * When omitted, `gisl.create()` resolves it from the `environment` against
   * the contract-declared stream hosts. It is **never derived from `baseUrl`**
   * — if nothing declares a stream host for your configuration, `streamEvents`
   * throws `GislStreamHostNotDeclaredError` rather than silently reusing the
   * API host, and `run()` falls back to polling. See
   * `ENVIRONMENT_STREAM_ENDPOINTS`.
   */
  streamBaseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeout?: number;
  /**
   * Send credentials (cookies) on every fetch — required in browsers when
   * authenticating via the session cookie issued by `POST /api/auth/login`
   * (Symfony firewall). Default `false` — the SDK ships in API-key mode by
   * default. Set to `true` for browser SPAs that drive the auth flow via
   * `client.login()` / `client.logout()` so the session cookie persists
   * across requests.
   *
   * Node session persistence (cookie-jar across processes) is out of scope —
   * this flag only flips fetch's `credentials` option; cookie storage is the
   * environment's responsibility.
   */
  useSessionCookie?: boolean;
  /**
   * Preferred response language. When set, the SDK sends
   * `Accept-Language: <locale>` on every GISL-API request (e.g. `'fr-FR'`,
   * `'de'`). The server echoes the language it actually resolved via the
   * `Content-Language` response header, surfaced on
   * `GislApiError.contentLanguage`. When no supported language matches, the
   * server falls back to its default (typically `en-GB`).
   *
   * A dedicated `locale` wins over any `Accept-Language` passed through
   * `headers` (mirrors how `apiKey` wins over a caller-supplied
   * `Authorization` header); the conflicting `headers` entry is dropped
   * case-insensitively so the request never carries two variants.
   */
  locale?: string;
  /** Threshold in bytes above which multipart upload is used (default: 10MB) */
  multipartThreshold?: number;
  /**
   * Max concurrent chunk uploads for multipart (default: 4). Non-finite or
   * fractional values are coerced via `Math.floor`; `NaN`/`Infinity` and
   * non-positive values fall back to the default. Zero workers would produce
   * a multipart-complete with an incomplete parts array (silent corruption),
   * so the sanitiser snaps below-1 to default rather than to 1.
   */
  multipartConcurrency?: number;
  /**
   * Max total attempts per multipart S3 PUT, including the first try
   * (default: 3 — one initial + two retries). 0 or 1 disables retry.
   * Non-finite or fractional values are coerced via `Math.floor` and
   * floored at 1; `NaN`/`Infinity` fall back to the default.
   * Retries fire on 5xx/429 responses and on network TypeError; 4xx (other
   * than 429) and abort signals fail fast.
   */
  multipartMaxAttempts?: number;
  /**
   * Base milliseconds for full-jitter exponential backoff between multipart
   * retry attempts (default: 500). Each retry's delay is `random(0, base * 2^n)`
   * where n is the zero-indexed retry number. `0` opts out of backoff (retries
   * fire immediately) — useful for tests; not recommended for production where
   * jitter is the only defence against thundering-herd retry storms against
   * shared-throttling sources like S3. `NaN`/`Infinity` fall back to the default.
   */
  multipartRetryBaseMs?: number;
}

// ---------------------------------------------------------------------------
// Operation definition (typed replacement for generated `any`)
// ---------------------------------------------------------------------------

export interface OperationDef {
  type: OperationType;
  options?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// v2 source variants — discriminated by `type` wire key
// ---------------------------------------------------------------------------

export interface UploadSourcePayload {
  type: 'upload';
  file_id: string;
}

export interface JobOutputSourcePayload {
  type: 'job_output';
  from: string;
  operation?: string;
}

export interface ExternalImportSourcePayload {
  type: 'external_import';
  external_source_id: string;
}

export interface ConnectionSourcePayload {
  type: 'connection';
  connection_id: string;
  path: string;
}

export type WorkflowSourcePayload =
  | UploadSourcePayload
  | JobOutputSourcePayload
  | ExternalImportSourcePayload
  | ConnectionSourcePayload;

/**
 * The source leaves a multi-input `JobInputV2Payload.source` may take —
 * `WorkflowSourcePayload` minus the `upload` leaf. Per the contract
 * (`MultiInputSource` in `openapi/api.yaml`), multi-input operations
 * (merge / archive / image_watermark / custom_luma / audio_overlay) do NOT
 * accept upload-direct: an uploaded file enters a multi-input job via a
 * `passthrough` source job referenced downstream by `{ type: 'job_output' }`.
 * Single-input `JobDefinitionPayload.source` keeps the wider
 * `WorkflowSourcePayload` (upload-direct is valid there).
 *
 * Named with the SDK's `*Payload` suffix to match every sibling source type
 * and to avoid colliding with the generated `MultiInputSource` model (a
 * different, deep-import-only type family).
 */
export type MultiInputSourcePayload =
  | JobOutputSourcePayload
  | ExternalImportSourcePayload
  | ConnectionSourcePayload;

// ---------------------------------------------------------------------------
// Source factories — return wire-format objects with the `type` discriminator
// ---------------------------------------------------------------------------

export function uploadSource(fileId: string): UploadSourcePayload {
  return { type: 'upload', file_id: fileId };
}

export function jobOutputSource(
  from: string,
  operation?: string,
): JobOutputSourcePayload {
  return operation === undefined
    ? { type: 'job_output', from }
    : { type: 'job_output', from, operation };
}

export function externalImportSource(
  externalSourceId: string,
): ExternalImportSourcePayload {
  return { type: 'external_import', external_source_id: externalSourceId };
}

export function connectionSource(
  connectionId: string,
  path: string,
): ConnectionSourcePayload {
  return { type: 'connection', connection_id: connectionId, path };
}

// ---------------------------------------------------------------------------
// JobInputV2 — multi-input entry per ADR-0004
// ---------------------------------------------------------------------------

export interface JobInputV2Payload {
  source: MultiInputSourcePayload;
  role?: JobInputV2RoleEnum;
  per_input_options?: Record<string, unknown>;
}

// Compile-time invariant: a multi-input `source` must NEVER admit upload-direct.
// tsc fails at the `_AssertTrue<...>` line below if `JobInputV2Payload.source`
// is widened back to a type that includes `UploadSourcePayload` (e.g. reverting
// to `WorkflowSourcePayload`). Uploads enter multi-input ops via a `passthrough`
// source job referenced by `{ type: 'job_output' }` — see MultiInputSourcePayload.
type _JobInputV2SourceRejectsUpload =
  [Extract<JobInputV2Payload['source'], UploadSourcePayload>] extends [never]
    ? true
    : ['DRIFT: JobInputV2Payload.source admits upload-direct — multi-input must use MultiInputSourcePayload (job_output / external_import / connection)'];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _JobInputV2SourceRejectsUploadAssertion = _AssertTrue<_JobInputV2SourceRejectsUpload>;

// Compile-time invariant: MultiInputSourcePayload is EXACTLY WorkflowSourcePayload
// minus the upload leaf. Catches contract drift in either direction — a new
// source variant that should (not) be multi-input-eligible, or `upload` leaking
// back into the multi-input union.
type _MultiInputDrift =
  [Exclude<WorkflowSourcePayload, MultiInputSourcePayload>] extends [UploadSourcePayload]
    ? [UploadSourcePayload] extends [Exclude<WorkflowSourcePayload, MultiInputSourcePayload>]
      ? true
      : ['DRIFT: upload leaked back into MultiInputSourcePayload (multi-input must exclude upload-direct)']
    : ['DRIFT: MultiInputSourcePayload drops a non-upload variant that should remain'];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _MultiInputSourcePayloadDriftAssertion = _AssertTrue<_MultiInputDrift>;

// Compile-time cross-check against the GENERATED contract types. The assertions
// above only relate the hand-written aliases to each other, so both could drift
// from the contract in lockstep without failing tsc. These anchor the discriminant
// SETS to `@giveitsmaller/contracts/openapi` — a contract regen that adds/removes a
// source variant fails here until the hand-written unions are updated. The
// hand-written `*SourcePayload` leaves are deliberately a separate type family from
// the generated source models, so we compare only the `type` discriminants, not the
// full structures.
type _WorkflowSourceDiscriminantsMatchContract =
  [WorkflowSourcePayload['type']] extends [WorkflowSource['type']]
    ? [WorkflowSource['type']] extends [WorkflowSourcePayload['type']]
      ? true
      : ['DRIFT: contract WorkflowSource has a source discriminant missing from WorkflowSourcePayload']
    : ['DRIFT: WorkflowSourcePayload has a source discriminant not in contract WorkflowSource'];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WorkflowSourceDiscriminantsMatchContractAssertion =
  _AssertTrue<_WorkflowSourceDiscriminantsMatchContract>;

type _MultiInputSourceDiscriminantsMatchContract =
  [MultiInputSourcePayload['type']] extends [MultiInputSource['type']]
    ? [MultiInputSource['type']] extends [MultiInputSourcePayload['type']]
      ? true
      : ['DRIFT: contract MultiInputSource has a discriminant missing from MultiInputSourcePayload']
    : ['DRIFT: MultiInputSourcePayload has a discriminant not in contract MultiInputSource'];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _MultiInputSourceDiscriminantsMatchContractAssertion =
  _AssertTrue<_MultiInputSourceDiscriminantsMatchContract>;

// ---------------------------------------------------------------------------
// JobDefinition (single shape; `source` XOR `inputs[]` — runtime-enforced)
// ---------------------------------------------------------------------------

export interface JobDefinitionPayload {
  /**
   * Optional local identifier within the workflow. Server auto-generates
   * `^job_\d+$` when omitted; the SDK MUST NOT auto-generate. Required
   * when this job is referenced by another job's `JobOutputSource.from`,
   * `workflow_edges`, or `delivery.selection.explicit.refs[]`.
   */
  id?: string;
  /** Single-input source. Mutually exclusive with `inputs[]` (server enforces). */
  source?: WorkflowSourcePayload;
  /** Multi-input list for merge / archive / image_watermark / custom_luma / audio_overlay. */
  inputs?: JobInputV2Payload[];
  operations: OperationDef[];
  /** Per-job hide-intermediates promotion flag per ADR-0003. */
  deliver?: boolean;
}

/**
 * Single source of truth for JobDefinitionPayload's top-level wire keys.
 * Read by `contract-drift-fields.test.ts` to cross-check against the spec
 * at `JobDefinition`. Not re-exported from `index.ts`; this is reachable
 * only via deep imports and should not be treated as public API.
 *
 * The V1-only `skip_compression` field is deliberately absent (eQnUMW68);
 * the runtime drift test will fail if the spec re-introduces it OR adds
 * any other V1-leak field to the V2 JobDefinition schema.
 * @internal
 */
export const JOB_DEFINITION_PAYLOAD_KEYS = Object.freeze([
  'id',
  'source',
  'inputs',
  'operations',
  'deliver',
] as const);

// Compile-time invariant: JOB_DEFINITION_PAYLOAD_KEYS must exactly equal
// keyof JobDefinitionPayload. Same load-bearing pattern as
// _WorkflowCreatePayloadDriftAssertion below — tsc fails at the
// `_AssertTrue<...>` line with the specific extra/missing keys named in
// the error tuple.
type _ExpectedJobDefinitionPayloadKey = (typeof JOB_DEFINITION_PAYLOAD_KEYS)[number];
type _ExcessJobPayload = Exclude<keyof JobDefinitionPayload, _ExpectedJobDefinitionPayloadKey>;
type _ExcessJobExpected = Exclude<_ExpectedJobDefinitionPayloadKey, keyof JobDefinitionPayload>;
type _JobDefinitionPayloadDrift =
  [_ExcessJobPayload] extends [never]
    ? [_ExcessJobExpected] extends [never]
      ? true
      : ['DRIFT: JobDefinitionPayload is missing keys declared in JOB_DEFINITION_PAYLOAD_KEYS', _ExcessJobExpected]
    : ['DRIFT: JobDefinitionPayload has EXTRA keys not in JOB_DEFINITION_PAYLOAD_KEYS', _ExcessJobPayload];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _JobDefinitionPayloadDriftAssertion = _AssertTrue<_JobDefinitionPayloadDrift>;

// ---------------------------------------------------------------------------
// External destination (workflow-level export). Discriminated union over
// `connection` | `external_import`. Replaces V1 `ExportConfig`.
// ---------------------------------------------------------------------------

export type ExternalDestinationPayload =
  | { type: 'connection'; connection_id: string; path: string }
  | { type: 'external_import'; external_source_id: string };

// ---------------------------------------------------------------------------
// Delivery (workflow-level) per ADR-0003
// ---------------------------------------------------------------------------

export type DeliveryModePayload = 'individual' | 'bundle' | 'both';
export type DeliveryBundleFormatPayload = 'zip' | 'tar_gz';
export type DeliverySelectionTypePayload = 'terminal' | 'all_outputs' | 'explicit';

export interface DeliveryOutputRefPayload {
  ref: string;
  operation?: string;
}

export interface DeliverySelectionPayload {
  type: DeliverySelectionTypePayload;
  refs?: DeliveryOutputRefPayload[];
}

export interface DeliveryPayload {
  mode?: DeliveryModePayload;
  bundle_format?: DeliveryBundleFormatPayload;
  bundle_filename?: string;
  include_metadata?: boolean;
  selection?: DeliverySelectionPayload;
}

// ---------------------------------------------------------------------------
// Workflow processing hint (workflow-level) per I15-CONS
// ---------------------------------------------------------------------------

export type ProcessingClassHintPayload =
  | 'auto'
  | 'short_form_only'
  | 'long_form_allowed'
  | 'long_form_preferred';

export interface WorkflowProcessingPayload {
  class_hint?: ProcessingClassHintPayload;
}

// ---------------------------------------------------------------------------
// Workflow creation request (SDK-level, wire-format ready, snake_case)
// ---------------------------------------------------------------------------

export interface WorkflowCreatePayload {
  jobs: JobDefinitionPayload[];
  /**
   * Flat single-job form (with `operations`): top-level input source, described by
   * the contract as equivalent to `jobs: [{ source, operations }]` (contracts
   * D0Gsri8V, v2.64.0). The spec's `oneOf` makes `jobs` and `source`+`operations`
   * mutually exclusive.
   *
   * 🔴 **DO NOT SEND IT. The flat form is `x-availability: planned` as of contracts
   * v2.201.0 and the server does not accept it.** Send `jobs[]`, which is what both
   * SDK builders always emit — these two fields are typed optional for
   * spec-completeness only.
   *
   * ⚠️ **The equivalence above is the DESIGN, not observed behaviour**, and it
   * carried no availability marker from v2.64.0 until 2026-09-10 — which per
   * ADR-0001 §1.4 meant it read as `stable`, a GA claim about a shape nothing
   * accepts. No shipped SDK was ever exposed; a hand-built payload was.
   *
   * ⚠️ **A flat request is rejected today with a generic "At least one job is
   * required", not the `feature_not_available` 422 a `planned` shape owes you.**
   * So do not read that message as a fault in your own payload. Tracked against
   * `compression_api`.
   */
  source?: WorkflowSourcePayload;
  /** Flat-form operation set (with `source`); equivalent to one job's `operations`. */
  operations?: OperationDef[];
  workflow_edges?: Array<{ from: string; to: string }>;
  callback_url?: string;
  callback_events?: CallbackEventType[];
  export?: ExternalDestinationPayload;
  delivery?: DeliveryPayload;
  processing?: WorkflowProcessingPayload;
  /**
   * Per-job completion notification (contracts v2.164.0, `notify.email`).
   * Opaque passthrough wire shape — the ergonomic `notifyEmail` surface
   * (SubmitOptions/RunOptions + builder convenience) is a separate follow-up
   * (card y6jsQCpb); this field only acknowledges the wire key so a
   * hand-built payload can carry it. Mirrors `export`/`delivery`/`processing`.
   */
  notify?: NotifyConfig;
}

/**
 * Single source of truth for WorkflowCreatePayload's top-level wire keys.
 * Read by `contract-drift-fields.test.ts` to cross-check against the spec at
 * POST /api/workflows. Not re-exported from `index.ts`; this is reachable
 * only via deep imports and should not be treated as public API.
 * @internal
 */
export const WORKFLOW_CREATE_PAYLOAD_KEYS = Object.freeze([
  'jobs',
  'source',
  'operations',
  'workflow_edges',
  'callback_url',
  'callback_events',
  'export',
  'delivery',
  'processing',
  'notify',
] as const);

// Compile-time invariant: WORKFLOW_CREATE_PAYLOAD_KEYS must exactly equal
// keyof WorkflowCreatePayload. The tuple wraps are load-bearing — a naked
// `A extends B` would distribute over the union and silently pass. tsc fails
// at the `_AssertTrue<...>` line below with the specific extra/missing keys
// named in the error tuple. This lives in src/ (not tests/) because
// tsconfig.json excludes tests from the build; and is pure-type (no `const`
// / `void`) so no runtime JS is emitted to the shipped module.
type _ExpectedWorkflowCreatePayloadKey = (typeof WORKFLOW_CREATE_PAYLOAD_KEYS)[number];
type _ExcessPayload = Exclude<keyof WorkflowCreatePayload, _ExpectedWorkflowCreatePayloadKey>;
type _ExcessExpected = Exclude<_ExpectedWorkflowCreatePayloadKey, keyof WorkflowCreatePayload>;
type _WorkflowCreatePayloadDrift =
  [_ExcessPayload] extends [never]
    ? [_ExcessExpected] extends [never]
      ? true
      : ['DRIFT: WorkflowCreatePayload is missing keys declared in WORKFLOW_CREATE_PAYLOAD_KEYS', _ExcessExpected]
    : ['DRIFT: WorkflowCreatePayload has EXTRA keys not in WORKFLOW_CREATE_PAYLOAD_KEYS', _ExcessPayload];
type _AssertTrue<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WorkflowCreatePayloadDriftAssertion = _AssertTrue<_WorkflowCreatePayloadDrift>;

// ---------------------------------------------------------------------------
// Schema fetch options
// ---------------------------------------------------------------------------

export interface GetSchemaOptions {
  /** Filter the schema to operations that accept this MIME type (e.g. `image/jpeg`). */
  mimeType?: string;
  /** Filter the schema to a single operation type. */
  operation?: OperationType;
  /**
   * Conditional revalidation: send the previously-received `ETag` value to
   * receive a 304-not-modified sentinel when the cached response is still
   * fresh. Strong-ETag comparison.
   */
  ifNoneMatch?: string;
  /**
   * Conditional revalidation: send the previously-received `Last-Modified`
   * value (HTTP-date) to receive a 304-not-modified sentinel when the
   * cached response is still fresh.
   */
  ifModifiedSince?: string;
  /** Cancel an in-flight schema fetch. Surfaces as `GislAbortError`. */
  signal?: AbortSignal;
}

export type GetSchemaResult =
  | {
      notModified: false;
      data: OperationsSchemaResponse;
      etag?: string;
      lastModified?: string;
    }
  | {
      notModified: true;
      etag?: string;
      lastModified?: string;
    };

/**
 * Typed projection of the operation-capability surface returned by
 * {@link ErgonomicClient.capabilities} (qUhxfDA5). Bundles the three v2.124
 * capability fields of `OperationsSchemaResponse` — previously typed but with
 * no ergonomic consumer — so a caller can read them without dropping to
 * `getSchema()` and its not-modified union.
 *
 * Mirrors the PHP `Gisl\Sdk\Ergonomic\CapabilitiesSnapshot` value object.
 */
export interface CapabilitiesSnapshot {
  /**
   * Tier-scoped operation-capability matrix, keyed by operation type
   * (`compress`, `convert`, …). Empty when the server omits the field.
   */
  readonly operations: Record<string, OperationCapability>;
  /**
   * Output-format property table (`hasAudioTrack` / `isAnimated`), keyed by
   * `output_format`. Tier-invariant. Empty when the server omits the field.
   */
  readonly outputProperties: Record<string, OutputProperties>;
  /**
   * Pre-flight image-encode capability matrix (`webpQualitySupported`,
   * `backgroundFlatten`). Tier-invariant. `undefined` when the server omits it.
   */
  readonly imageEncode?: ImageEncodeCapabilities;
}

// ---------------------------------------------------------------------------
// Credits / billing
// ---------------------------------------------------------------------------

export interface CreditsUsageOptions {
  /**
   * Page size. Server defaults to 20 and rejects values outside `[1, 100]`
   * with a 400 validation envelope.
   */
  limit?: number;
  /** Page offset (zero-based). Server default is 0. */
  offset?: number;
}

// ---------------------------------------------------------------------------
// Workflow history
// ---------------------------------------------------------------------------

export interface ListWorkflowsOptions {
  /**
   * Opaque pagination cursor from a previous page's `nextCursor`. Omit for
   * the first page; treat the value as opaque (do not parse).
   */
  cursor?: string;
  /**
   * Rows per page. Server defaults to 20 and rejects values outside `[1, 100]`
   * with a 400 validation envelope.
   */
  limit?: number;
  /**
   * Archived-row filter (mWQsiUun). Omitted / `false`: archived workflows are
   * EXCLUDED (the server default). `true`: ONLY archived workflows - the archive
   * view, for review or {@link GislClient.restoreWorkflow}.
   */
  archived?: boolean;
}

// ---------------------------------------------------------------------------
// Upload probe / preflight
// ---------------------------------------------------------------------------

/**
 * Aggregated result of a `preflightClips()` batch probe — N parallel calls
 * to `POST /api/uploads/{id}/probe`, partitioned by outcome so the caller
 * can drop bad clips before submitting a long-form merge workflow (per
 * plan v5 round 10 / F11). Aggregation is structural — `ok` is everything
 * the server marked workflow-ready, `rejected` is everything else with a
 * typed probe response, and `errors` carries probe-call failures (e.g.
 * the 422 `feature_not_available` envelope returned while the endpoint is
 * still `availability: planned`).
 */
export interface PreflightClipsResult {
  /** Probes that returned `probe_status: 'ok'`. Safe to include in a workflow. */
  ok: UploadProbeResponse[];
  /**
   * Probes that returned a non-`ok` `probe_status` (`corrupt`,
   * `unsupported_codec`, `missing_metadata`). The caller should exclude
   * these or convert them first.
   */
  rejected: UploadProbeResponse[];
  /**
   * Probe calls that themselves failed. Includes the
   * `feature_not_available` (422) responses returned while the endpoint
   * is `availability: planned` — narrow on `instanceof
   * GislFeatureNotAvailableError` to detect that case.
   */
  errors: PreflightClipError[];
}

export interface PreflightClipError {
  fileId: string;
  error: unknown;
}

// ---------------------------------------------------------------------------
// Polling options
// ---------------------------------------------------------------------------

/**
 * Read-time options for a single anonymous-readable workflow query.
 *
 * Carries the one-time capability token returned by an anonymous (null-owner)
 * workflow create (`WorkflowCreateResponse.cap`). Pass it on status / downloads
 * / events reads so a session-less caller can read its own workflow; the SDK
 * sends it as the `X-Workflow-Capability` header. Omit it for authenticated
 * reads — the session authorizes those. A wrong or missing token on a
 * null-owner workflow returns 404 (deliberately no existence oracle).
 */
export interface ReadCapabilityOptions {
  /** Anonymous-workflow capability token (the `cap` from workflow-create). */
  capability?: string;
}

export interface WaitOptions {
  /** Poll interval in milliseconds (default: 2000) */
  intervalMs?: number;
  /** Maximum wait time in milliseconds (default: `DEFAULT_POLL_TIMEOUT_MS`, 10 min). */
  timeoutMs?: number;
  /** Called after each poll with current status */
  onPoll?: (status: string) => void;
  /**
   * Anonymous-workflow capability token (the `cap` from workflow-create),
   * forwarded to each underlying status poll as the `X-Workflow-Capability`
   * header. Required to poll a null-owner workflow without a session; omit
   * for authenticated polling.
   */
  capability?: string;
}

// ---------------------------------------------------------------------------
// Upload-probe wait (waitForProbe) — see GislClient.waitForProbe
// ---------------------------------------------------------------------------

export interface ProbeWaitOptions {
  /**
   * Overall wall-clock bound for the poll loop in ms (default: 30000). On
   * elapse the loop gives up and resolves `{ landed: false, reason: 'timeout' }`
   * — it never throws for a slow probe (the caller then creates anyway).
   */
  timeoutMs?: number;
  /** Abort the wait early; aborting rejects the promise with `GislAbortError`. */
  signal?: AbortSignal;
  /**
   * Fires once per poll attempt — drive an "analysing video…" UI in the gap
   * between upload-complete and workflow-create. `attempt` is 1-based;
   * `elapsedMs` is wall-clock since the wait started.
   */
  onPoll?: (info: { attempt: number; elapsedMs: number }) => void;
}

export interface ProbeWaitResult {
  /**
   * True iff the probe landed — i.e. `POST /api/uploads/{id}/probe` returned
   * 200 (ANY `probeStatus`: ok / corrupt / unsupported_codec / missing_metadata).
   * The caller proceeds to create the workflow either way; a landed probe lets
   * the server admit the parallel video split.
   */
  landed: boolean;
  /** The landed probe response — present iff `landed`. */
  probe?: UploadProbeResponse;
  /**
   * Why the wait gave up WITHOUT a landed probe — present iff `!landed`.
   * `timeout` = the bound elapsed; `prober_error` = repeated 5xx from the
   * prober. In both cases the caller should create anyway (never-bounce); the
   * server's size heuristic routes the job (single-task worst case).
   */
  reason?: 'timeout' | 'prober_error';
}

// ---------------------------------------------------------------------------
// SSE event types (SDK-level typed discriminated union)
// ---------------------------------------------------------------------------

export type GislSseEvent =
  | { event: typeof SseEventType.operation_progress; data: SseOperationProgressData }
  | { event: typeof SseEventType.operation_completed; data: SseOperationCompletedData }
  | { event: typeof SseEventType.operation_failed; data: SseOperationFailedData }
  | { event: typeof SseEventType.job_completed; data: SseJobCompletedData }
  | { event: typeof SseEventType.job_failed; data: SseJobFailedData }
  | { event: typeof SseEventType.workflow_completed; data: SseWorkflowTerminalData }
  | { event: typeof SseEventType.workflow_failed; data: SseWorkflowTerminalData }
  | { event: typeof SseEventType.workflow_partially_failed; data: SseWorkflowTerminalData }
  | { event: string; data: unknown };

/**
 * A typed, non-throwing diagnostic surfaced when an SSE frame's `data:` body fails
 * to JSON-parse (TYNjcjpo). The malformed frame is SKIPPED from the event stream —
 * a long-running consumer must not break on one garbled server frame — but the
 * failure is observable via the `onParseError` callback on `streamEvents` /
 * `parseSseStream` rather than silently lost. Mirrors the PHP `GislSseParseFailure`
 * value object; the shape is identical across the two SDKs (cross-SDK parity).
 */
export interface GislSseParseFailure {
  /** The joined `data:` line(s) that failed to parse. */
  readonly raw: string;
  /** The frame's event type (or `'message'` when the frame had no `event:` field). */
  readonly event: string;
  /** The parse error message (e.g. the `JSON.parse` `SyntaxError` text). */
  readonly error: string;
}

// ---------------------------------------------------------------------------
// Upload options
// ---------------------------------------------------------------------------

export interface UploadOptions {
  /** Called with bytes uploaded so far (only for multipart) */
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  /**
   * Cancel an in-flight upload. Aborting rejects the `uploadFile` promise with
   * `GislAbortError`. Applies to the API requests (initiate, complete) and
   * every S3 part PUT. Composes with the client-level per-request timeout —
   * whichever callback fires first determines the error class: user abort
   * first → `GislAbortError`; timer first → `GislTimeoutError`.
   */
  signal?: AbortSignal;
  /**
   * Optional metadata hint forwarded to multipart initiate so the server
   * can size-check and preflight-route based on caller-asserted dimensions.
   * Single-shot uploads ignore this field (the multipart initiate is the
   * only endpoint that accepts it). Wire-encoded as a JSON-stringified
   * single FormData field on the multipart/initiate request.
   */
  metadataHint?: MultipartInitiateRequestMetadataHint;
  /**
   * Resume an in-progress multipart upload (SDK-3 / Wb6ebOMM).
   *
   * When set, `uploadFile()` skips `/multipart/initiate` entirely. Instead it
   * walks `GET /api/uploads/multipart/{uploadId}/status` (paginated via
   * `next_part_number_marker` / `is_truncated`), computes which parts are
   * still missing, re-presigns them in batches of <=100 via
   * `POST /api/uploads/multipart/{uploadId}/presign`, PUTs only the missing
   * parts, then `POST /api/uploads/multipart/complete`.
   *
   * The caller's `file` argument MUST be byte-identical to the file used in
   * the original initiate call (same byte content at the same offsets).
   * Mismatched bytes will produce S3 etags that don't match the server's
   * recorded state, and `/multipart/complete` will reject.
   *
   * Anonymous-initiated sessions cannot be resumed by an authed caller
   * (server returns 403 → `GislMultipartSessionAuthRequiredError`); a
   * non-existent or expired session returns 404 →
   * `GislMultipartSessionNotFoundError`.
   */
  resumeUploadId?: string;
  /**
   * Called after every successful part PUT during fresh-upload AND resume
   * paths. Receives a JSON-serialisable snapshot of the upload state — round-
   * trippable via `JSON.stringify` for persistence across process restarts,
   * so a future `uploadFile({ resumeUploadId: state.uploadId, ... })` can
   * pick up where the prior process stopped.
   *
   * The callback is invoked OUTSIDE the per-part retry-scoped path: a throw
   * here will fail the upload but NEVER trigger a duplicate PUT (mirrors the
   * `onProgress` discipline at `client.ts:1195-1199`).
   */
  onCheckpoint?: (state: MultipartCheckpointState) => void;
}

/**
 * JSON-serialisable snapshot of an in-progress multipart upload, emitted
 * after every successful part PUT via `UploadOptions.onCheckpoint`. Designed
 * to round-trip through `JSON.stringify` / `JSON.parse` so consumers can
 * persist it across process restarts and resume via
 * `uploadFile({ resumeUploadId: state.uploadId, ... })`.
 *
 * All fields are primitive: no `Date` (use the ISO-8601 string on
 * `manifestExpiresAt`), no `Buffer`, no functions.
 */
export interface MultipartCheckpointState {
  /** The server-assigned `upload_id` (UUID) used as `resumeUploadId` later. */
  readonly uploadId: string;
  /** Total parts the server computed for this upload. <=10 000. */
  readonly totalParts: number;
  /**
   * Part numbers (1-indexed) that have been successfully PUT to S3 so far.
   * Includes part 1 (the initiate first chunk) once a part >= 2 lands. Sorted
   * ascending. Excluded numbers in `[1, totalParts]` are the still-missing
   * set a resume must re-PUT.
   */
  readonly uploadedPartNumbers: readonly number[];
  /**
   * ISO-8601 wall-clock instant at which the server's durable manifest for
   * this `uploadId` expires (currently a 48h TTL per the API-2 contract). On
   * resume, clients SHOULD call `keepaliveUpload(uploadId)` every 12-24h to
   * extend this, leaving >=24h of slack against the 48h ceiling even with
   * worst-case clock skew between client and server.
   */
  readonly manifestExpiresAt: string;
}

// ---------------------------------------------------------------------------
// SDK-3 hand-coded resume-support shapes (TODO(HxUmVr3Y): replace on regen).
//
// API-2 / PR #283 shipped the 3 resume-support endpoints (`/status`,
// `/presign`, `/keepalive`); contracts ticket HxUmVr3Y will add the OpenAPI
// schemas that drive the openapi-generator output. Until that regen lands,
// these types are hand-coded so SDK-3 ships unblocked. Every public type and
// call-site is prefixed `_Sdk3HandCoded` so the eventual regen sweep is a
// mechanical grep — find every reference and re-point at the generated
// `@giveitsmaller/contracts/openapi` types.
//
// Wire shape is snake_case (matches API-2's PHP response writer); the TS
// surface here uses camelCase consistent with the rest of the SDK's
// hand-written types. The client.ts code path that SENDS the `/presign`
// request body marshals to the snake_case wire object inline; the response
// shapes are read in camelCase after the `handleResponse` envelope unwrap
// (callers narrow on field names from these interfaces).
// ---------------------------------------------------------------------------

/**
 * One entry in `_Sdk3HandCodedMultipartStatusResult.uploadedParts`. Aggregated
 * across all pages of the underlying `GET /status` endpoint by the SDK's
 * walk-pagination loop.
 *
 * TODO(HxUmVr3Y): replace hand-coded shape on regen.
 */
export interface _Sdk3HandCodedUploadedPart {
  readonly partNumber: number;
  readonly etag: string;
  readonly sizeBytes: number;
  /** ISO-8601 last-modified instant of the S3 part. */
  readonly lastModified: string;
}

/**
 * Aggregated result of `getUploadStatus()` after the SDK has walked every
 * page of the underlying `GET /api/uploads/multipart/{uploadId}/status`
 * endpoint (paginated via `next_part_number_marker` / `is_truncated`).
 * `uploadedParts` is the merged-and-sorted list of every part the server
 * has recorded across all pages — callers see the complete state without
 * needing to drive the pagination cursor themselves.
 *
 * TODO(HxUmVr3Y): replace hand-coded shape on regen.
 */
export interface _Sdk3HandCodedMultipartStatusResult {
  readonly uploadId: string;
  readonly multipartUploadId: string;
  readonly cloudKey: string;
  readonly totalParts: number;
  /** Sorted ascending by `partNumber`; complete across all server-side pages. */
  readonly uploadedParts: readonly _Sdk3HandCodedUploadedPart[];
  /** ISO-8601 wall-clock when the durable session manifest expires. */
  readonly manifestExpiresAt: string;
  /** Server-recommended chunk size in bytes (matches the initiate envelope). */
  readonly recommendedChunkSize: number;
}

/**
 * One entry in `_Sdk3HandCodedPresignPartsResult.presignedUrls`. Shape mirrors
 * the contract-pinned `PresignedUrlPart` from the initiate envelope; kept
 * hand-coded here so the resume path does not depend on the generator's name
 * for that shape (decoupling for the HxUmVr3Y regen window).
 *
 * TODO(HxUmVr3Y): replace hand-coded shape on regen.
 */
export interface _Sdk3HandCodedPresignedPart {
  readonly partNumber: number;
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * Result of `presignParts()` — the server-issued presigned PUT URLs for the
 * requested part numbers.
 *
 * TODO(HxUmVr3Y): replace hand-coded shape on regen.
 */
export interface _Sdk3HandCodedPresignPartsResult {
  readonly uploadId: string;
  readonly presignedUrls: readonly _Sdk3HandCodedPresignedPart[];
}

/**
 * Result of `keepaliveUpload()` — the refreshed manifest TTL expiry instant.
 *
 * TODO(HxUmVr3Y): replace hand-coded shape on regen.
 */
export interface _Sdk3HandCodedKeepaliveResult {
  readonly uploadId: string;
  readonly manifestExpiresAt: string;
}
