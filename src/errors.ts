import type {
  AuthErrorResponse,
  BalanceExhaustedResponse,
  FeatureNotAvailableResponse,
  FeatureTierRestrictedResponse,
  ProbePendingResponse,
  TierRestrictionResponse,
  UploadDurationExceedsTierResponse,
  UploadSizeExceedsTierResponse,
  WorkflowExpiredResponse,
} from '@giveitsmaller/contracts/openapi';

export class GislError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GislError';
  }
}

/**
 * Optional structured fields carried alongside a typed API error. The
 * localisation triple (`messageKey`, `locale`, `messageParams`) mirrors the
 * `ErrorEnvelope` localisation contract from `compression_contracts`
 * (ticket I26). `payload` carries the full typed response envelope for the
 * structured error subclasses that have one.
 */
export interface GislApiErrorOptions {
  readonly messageKey?: string;
  readonly locale?: string;
  readonly messageParams?: Record<string, unknown>;
  readonly payload?: unknown;
}

export class GislApiError extends GislError {
  readonly statusCode: number;
  readonly errorMessage: string;
  readonly path?: string;
  readonly details?: unknown;
  readonly messageKey?: string;
  readonly locale?: string;
  readonly messageParams?: Record<string, unknown>;
  readonly payload?: unknown;

  constructor(
    statusCode: number,
    errorMessage: string,
    path?: string,
    details?: unknown,
    options?: GislApiErrorOptions,
  ) {
    const prefix = path
      ? `API error ${statusCode} at ${path}`
      : `API error ${statusCode}`;
    super(`${prefix}: ${errorMessage}`);
    this.name = 'GislApiError';
    this.statusCode = statusCode;
    this.errorMessage = errorMessage;
    this.path = path;
    this.details = details;
    if (options) {
      this.messageKey = options.messageKey;
      this.locale = options.locale;
      this.messageParams = options.messageParams;
      this.payload = options.payload;
    }
  }
}

/**
 * Shape of a single validation detail entry. Mirrors the v2
 * `ValidationErrorEnvelopeDetailsInner` contract: only `message` is required;
 * `field` / `operation` / `option` are mutually-permissive identifiers (a
 * given detail may carry one, two, or all three depending on whether the
 * violation is single-field, per-option, or cross-field).
 */
export interface GislValidationDetail {
  readonly message: string;
  readonly field?: string;
  readonly operation?: string;
  readonly option?: string;
  readonly messageKey?: string;
  readonly locale?: string;
  readonly messageParams?: Record<string, unknown>;
}

export class GislValidationError extends GislApiError {
  // `declare` narrows the inherited `details: unknown` to the validation shape
  // without emitting a runtime field declaration. Emitting one under
  // ES2022 / useDefineForClassFields would run after super() and overwrite
  // the parent's assignment with `undefined`.
  declare readonly details: GislValidationDetail[];

  constructor(
    statusCode: number,
    errorMessage: string,
    details: GislValidationDetail[],
    path?: string,
    options?: GislApiErrorOptions,
  ) {
    super(statusCode, errorMessage, path, details, options);
    this.name = 'GislValidationError';
  }
}

// Shared constructor body for the structured-payload subclasses. Five of the
// six subclasses below differ only in their typed `payload` and `name` —
// factor the common construction here so each subclass remains a one-liner.
function buildOptionsWithPayload(
  payload: unknown,
  extra: Omit<GislApiErrorOptions, 'payload'> | undefined,
): GislApiErrorOptions {
  return { ...extra, payload };
}

export class GislBalanceExhaustedError extends GislApiError {
  declare readonly payload: BalanceExhaustedResponse;

  constructor(
    statusCode: number,
    errorMessage: string,
    payload: BalanceExhaustedResponse,
    path?: string,
    extra?: Omit<GislApiErrorOptions, 'payload'>,
  ) {
    super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
    this.name = 'GislBalanceExhaustedError';
  }
}

export class GislTierRestrictedError extends GislApiError {
  declare readonly payload: TierRestrictionResponse;

  constructor(
    statusCode: number,
    errorMessage: string,
    payload: TierRestrictionResponse,
    path?: string,
    extra?: Omit<GislApiErrorOptions, 'payload'>,
  ) {
    super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
    this.name = 'GislTierRestrictedError';
  }
}

export class GislFeatureTierRestrictedError extends GislApiError {
  declare readonly payload: FeatureTierRestrictedResponse;

  constructor(
    statusCode: number,
    errorMessage: string,
    payload: FeatureTierRestrictedResponse,
    path?: string,
    extra?: Omit<GislApiErrorOptions, 'payload'>,
  ) {
    super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
    this.name = 'GislFeatureTierRestrictedError';
  }
}

export class GislFeatureNotAvailableError extends GislApiError {
  declare readonly payload: FeatureNotAvailableResponse;

  constructor(
    statusCode: number,
    errorMessage: string,
    payload: FeatureNotAvailableResponse,
    path?: string,
    extra?: Omit<GislApiErrorOptions, 'payload'>,
  ) {
    super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
    this.name = 'GislFeatureNotAvailableError';
  }
}

/**
 * 422 response on `POST /api/workflows` when a job references an upload
 * whose server-side probe hasn't completed at workflow-create time. The
 * server rejects rather than silently routing as `short_form` (which
 * hard-fails long video clips).
 *
 * **Recovery contract** (per contracts ProbePendingResponse docblock):
 * poll `POST /api/uploads/{id}/probe` for the pending upload until
 * `probe_status` is terminal (`ok` → re-`POST /api/workflows` the same
 * request; `corrupt` / `unsupported_codec` → surface the probe error).
 * The `Retry-After` response header (when present) suggests a delay
 * in seconds before the next poll/retry.
 *
 * `payload.jobRef` identifies which job in the multi-job request triggered
 * the probe-pending rejection.
 *
 * @example
 * try {
 *   await client.createWorkflow({ jobs });
 * } catch (e) {
 *   if (e instanceof GislProbePendingError) {
 *     await waitForProbe(e.payload.jobRef);
 *     // retry...
 *   }
 *   throw e;
 * }
 */
export class GislProbePendingError extends GislApiError {
  declare readonly payload: ProbePendingResponse;

  constructor(
    statusCode: number,
    errorMessage: string,
    payload: ProbePendingResponse,
    path?: string,
    extra?: Omit<GislApiErrorOptions, 'payload'>,
  ) {
    super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
    this.name = 'GislProbePendingError';
  }
}

export class GislWorkflowExpiredError extends GislApiError {
  declare readonly payload: WorkflowExpiredResponse;

  constructor(
    statusCode: number,
    errorMessage: string,
    payload: WorkflowExpiredResponse,
    path?: string,
    extra?: Omit<GislApiErrorOptions, 'payload'>,
  ) {
    super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
    this.name = 'GislWorkflowExpiredError';
  }
}

export class GislAuthError extends GislApiError {
  declare readonly payload: AuthErrorResponse;

  constructor(
    statusCode: number,
    errorMessage: string,
    payload: AuthErrorResponse,
    path?: string,
    extra?: Omit<GislApiErrorOptions, 'payload'>,
  ) {
    super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
    this.name = 'GislAuthError';
  }
}

/**
 * Discriminates the four upload-too-big shapes the server can return:
 * - `size_tier`        — 422 `upload_size_exceeds_tier` (typed payload present)
 * - `duration_tier`    — 422 `upload_duration_exceeds_tier` (typed payload present)
 * - `absolute_413`     — 413, the absolute across-tier cap. The contract models
 *                        413 as a plain `ErrorEnvelope` with NO `error_type`
 *                        discriminator, so there is NO typed payload for it.
 * - `cap_v2_multipart` — 422 `FILE_TOO_LARGE_FOR_MULTIPART` (SDK-3 / Wb6ebOMM,
 *                        pre-S3 capacity reject on the resume-support endpoints).
 *                        The contract carries no structured payload for this
 *                        code today — `payload` is undefined for this kind.
 *
 * **Caveat for exhaustive-narrowing consumers.** The `cap_v2_multipart` value
 * was added in TS SDK 0.5.0 / PHP SDK 0.3.0. A consumer writing
 * `switch (e.kind) { case 'size_tier': ... case 'duration_tier': ... default:
 * absurd(e.kind); }` against the prior 3-value union now sees a non-exhaustive
 * switch and must add the new arm. The bump is logged in CHANGELOG.md.
 */
export type GislUploadCapKind =
  | 'size_tier'
  | 'duration_tier'
  | 'absolute_413'
  | 'cap_v2_multipart';

/**
 * A single class covering all three "upload exceeds a size/duration cap"
 * responses (422 size-tier, 422 duration-tier, 413 absolute).
 *
 * CONSCIOUS DEVIATION from the one-typed-payload-per-class invariant that the
 * other structured subclasses follow (`GislBalanceExhaustedError`,
 * `GislWorkflowExpiredError`, …). Justification: the card mandates this single
 * `GislUploadCapExceededError` name and SDK-3 / E2E-1 are blocked-on it, so
 * splitting into size/duration subclasses would break a cross-ticket naming
 * contract; and 413 carries no typed envelope at all (plain `ErrorEnvelope`),
 * so a one-payload-per-class split could not cover it uniformly anyway. The
 * `kind` discriminant + a union-typed (possibly absent) `payload` is the
 * deliberate trade-off. This is the only structured error in the tree that
 * does not bind exactly one payload type — documented here in the same spirit
 * as the inline PHP↔TS divergence notes.
 *
 * The two multipart-part errors below are deliberately NOT folded in with a
 * `kind`: they carry different fields (`partNumber`/`uploadId` for an instance
 * PUT failure vs `requiredParts`/`maxParts` for the count-ceiling guard) and
 * are thrown from the multipart path, not the response handler.
 */
export class GislUploadCapExceededError extends GislApiError {
  readonly kind: GislUploadCapKind;
  declare readonly payload:
    | UploadSizeExceedsTierResponse
    | UploadDurationExceedsTierResponse
    | undefined;

  constructor(
    statusCode: number,
    errorMessage: string,
    kind: GislUploadCapKind,
    payload:
      | UploadSizeExceedsTierResponse
      | UploadDurationExceedsTierResponse
      | undefined,
    path?: string,
    extra?: Omit<GislApiErrorOptions, 'payload'>,
  ) {
    super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
    this.name = 'GislUploadCapExceededError';
    this.kind = kind;
  }
}

/**
 * 404 `MULTIPART_SESSION_NOT_FOUND` — the durable multipart session referenced
 * by a resume / status / presign / keepalive call cannot be located (expired
 * past its 48h manifest TTL, deleted, or never existed). Thrown by the SDK-3
 * resume-support endpoints (`getUploadStatus`, `presignParts`,
 * `keepaliveUpload`, and the resume branch of `uploadFile`).
 *
 * Carries no typed structured payload — the contract for the 3 resume-support
 * endpoints models this code as a plain `ErrorEnvelope`. Consumers should
 * detect via `instanceof` and abandon the resume; a fresh `uploadFile()` call
 * (without `resumeUploadId`) will start a new session.
 */
export class GislMultipartSessionNotFoundError extends GislApiError {
  constructor(
    statusCode: number,
    errorMessage: string,
    path?: string,
    options?: GislApiErrorOptions,
  ) {
    super(statusCode, errorMessage, path, undefined, options);
    this.name = 'GislMultipartSessionNotFoundError';
  }
}

/**
 * 403 `MULTIPART_SESSION_OWNERSHIP` — the caller is authenticated but the
 * multipart session belongs to a different user. Thrown by the SDK-3
 * resume-support endpoints. The session itself exists (otherwise the server
 * would return 404 NOT_FOUND); the caller's identity simply doesn't match
 * `manifest.userId`. Consumers should abandon the resume.
 */
export class GislMultipartSessionOwnershipError extends GislApiError {
  constructor(
    statusCode: number,
    errorMessage: string,
    path?: string,
    options?: GislApiErrorOptions,
  ) {
    super(statusCode, errorMessage, path, undefined, options);
    this.name = 'GislMultipartSessionOwnershipError';
  }
}

/**
 * 403 `MULTIPART_SESSION_AUTH_REQUIRED` — the multipart session was initiated
 * anonymously (no `manifest.userId`) and the SDK-3 resume-support endpoints
 * refuse to serve it on an authed caller. There is no "claim" workflow today
 * to bind an authed identity to an anonymously-started session; that is the
 * future flip tracked at upstream ticket 8LABloaz. Consumers hitting this on
 * resume should abandon and re-upload from scratch under the authed identity.
 */
export class GislMultipartSessionAuthRequiredError extends GislApiError {
  constructor(
    statusCode: number,
    errorMessage: string,
    path?: string,
    options?: GislApiErrorOptions,
  ) {
    super(statusCode, errorMessage, path, undefined, options);
    this.name = 'GislMultipartSessionAuthRequiredError';
  }
}

/**
 * Optional structured metadata attached to a {@link GislConfigError}. The
 * preset resolver (T4b) raises errors with these fields populated so
 * callers can branch on machine-readable codes rather than parsing the
 * human message. Every field is optional — existing call sites that
 * throw `new GislConfigError(message)` keep working unchanged.
 */
export interface GislConfigErrorMetadata {
  /**
   * Machine-readable error code. Resolver-side values today:
   * `'invalid_combination'`, `'missing_dependency'`, `'type_mismatch'`,
   * `'unknown_field'`, `'invalid_target_size'`. Other call sites may add
   * codes — the union is open.
   */
  readonly reason?: string;
  /**
   * Field names (camelCase) that participated in the rejection. For
   * `invalid_combination` reasons this is the *pair* that conflicts
   * (e.g. `['targetSize', 'codec']`); for `missing_dependency` this is
   * the dependent field plus the field whose value blocks it.
   */
  readonly conflictingFields?: readonly string[];
  /**
   * The merged wire-shape snapshot the resolver computed BEFORE the
   * validation rejected it. Lets callers see "what would have been
   * sent" for debugging without re-running the chain.
   */
  readonly resolvedSnapshot?: Readonly<Record<string, unknown>>;
  /**
   * Short human-readable remediation hint specific to the error. E.g.
   * "Switch codec to H264, or drop targetSize and use crf instead."
   */
  readonly suggestion?: string;
}

/**
 * Root of the LOCAL config-error tree — thrown before any HTTP/file I/O.
 * Sibling of `GislApiError` (which represents server-side error envelopes).
 * Reserve for fail-early errors raised by the ergonomic-layer factory or
 * credential-chain resolver when the caller hasn't supplied something the
 * SDK needs to make a request. Never carries an HTTP status code.
 *
 * Optional `metadata` (T4b — `27rE1fZn`) carries structured fields used
 * by the preset resolver and other ergonomic-layer validators. Existing
 * call sites that pass `(message)` keep working — metadata is purely
 * additive and defaults to `undefined`.
 */
export class GislConfigError extends GislError {
  readonly reason?: string;
  readonly conflictingFields?: readonly string[];
  readonly resolvedSnapshot?: Readonly<Record<string, unknown>>;
  readonly suggestion?: string;

  constructor(message: string, metadata?: GislConfigErrorMetadata) {
    super(message);
    this.name = 'GislConfigError';
    if (metadata !== undefined) {
      if (metadata.reason !== undefined) this.reason = metadata.reason;
      if (metadata.conflictingFields !== undefined) {
        this.conflictingFields = metadata.conflictingFields;
      }
      if (metadata.resolvedSnapshot !== undefined) {
        this.resolvedSnapshot = metadata.resolvedSnapshot;
      }
      if (metadata.suggestion !== undefined) this.suggestion = metadata.suggestion;
    }
  }
}

/**
 * The ergonomic-layer factory `gisl.create()` could not resolve an API key
 * from any of explicit arg, `GISL_API_KEY` env, or shared-config profile,
 * AND the caller did not opt into anonymous or cookie-mode. Thrown BEFORE
 * any file read or HTTP request — calls to `client.compress(...)`, `.run()`,
 * etc., synchronously fail with this error.
 */
export class GislMissingCredentialsError extends GislConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'GislMissingCredentialsError';
  }
}

/**
 * The caller used `gisl.anonymous()` and then invoked an operation that is
 * not in the anonymous-capable allowlist. Local-only — thrown before any I/O.
 * Distinct from server-side `GislAuthError` (401/403 on the wire).
 */
export class GislFeatureRequiresAuthError extends GislConfigError {
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = 'GislFeatureRequiresAuthError';
    this.operation = operation;
  }
}

/**
 * `MergeBuilder.sequence(...)` referenced an asset that wasn't declared in
 * the prior `client.merge(...)` call. Local validation runs BEFORE upload
 * so the caller fails fast on the typo without burning bandwidth.
 */
export class GislUndeclaredAssetError extends GislConfigError {
  readonly assetId: string;
  readonly declaredAssets: readonly string[];

  constructor(assetId: string, declaredAssets: readonly string[]) {
    super(
      `Sequence references asset '${assetId}' but it wasn't declared in merge(...). ` +
        `Declared assets: [${declaredAssets.join(', ')}]. ` +
        `Either pass it to merge(...) before sequencing, or remove the reference.`,
    );
    this.name = 'GislUndeclaredAssetError';
    this.assetId = assetId;
    this.declaredAssets = declaredAssets;
  }
}

/**
 * `MergeBuilder.sequence(...)` was called but at least one declared asset
 * wasn't referenced. Almost always a bug (wasted upload). Escape via
 * `allowUnusedAssets: true` on the merge options.
 */
export class GislUnusedAssetError extends GislConfigError {
  readonly unusedAssets: readonly string[];

  constructor(unusedAssets: readonly string[]) {
    super(
      `Assets [${unusedAssets.join(', ')}] were declared in merge(...) but never sequenced. ` +
        `Reference them in .sequence(...), remove them from the declaration, ` +
        `or pass {allowUnusedAssets: true} to opt out of this check.`,
    );
    this.name = 'GislUnusedAssetError';
    this.unusedAssets = unusedAssets;
  }
}

/**
 * `MergeBuilder.sequence(...)` on an image merge was given a `clip(ref, opts)`
 * entry. Image merges have NO per-input options in the wire today — `transition`
 * applies at the merge level and is uniform across all joins.
 */
export class GislPerInputOptionsNotSupportedError extends GislConfigError {
  readonly mediaKind: string;

  constructor(mediaKind: string) {
    super(
      `${mediaKind} merge has no per-input options today; set 'transition' at the ` +
        `.merge(...) level instead — it applies to every join.`,
    );
    this.name = 'GislPerInputOptionsNotSupportedError';
    this.mediaKind = mediaKind;
  }
}

/**
 * Thrown by future chain methods (`.compress()` / `.thumbnail()` /
 * `.convert()` on an `OperationBuilder`) when the previous step produces
 * MULTIPLE artifacts and the caller didn't explicitly call `.mapEach(...)`
 * to opt into per-artifact fan-out. T6 ships the error class + the
 * `.mapEach(...)` method; the chain methods themselves are a separate
 * follow-up card, so this error is currently dormant — but the type +
 * audit-gate registration land here so the future chain-method PR is a
 * pure addition with no public-API churn.
 */
export class GislChainCardinalityMismatchError extends GislConfigError {
  readonly previousOperation: string;
  readonly attemptedOperation: string;

  constructor(previousOperation: string, attemptedOperation: string) {
    super(
      `Previous step (${previousOperation}) produces multiple artifacts; ` +
        `use .mapEach(art => art.${attemptedOperation}(...)) to apply the chain per-artifact, ` +
        `or branch to a single artifact first.`,
    );
    this.name = 'GislChainCardinalityMismatchError';
    this.previousOperation = previousOperation;
    this.attemptedOperation = attemptedOperation;
  }
}

export class GislTimeoutError extends GislError {
  constructor(message: string) {
    super(message);
    this.name = 'GislTimeoutError';
  }
}

export class GislAbortError extends GislError {
  constructor(message: string) {
    super(message);
    this.name = 'GislAbortError';
  }
}

/**
 * A single S3 multipart part PUT failed terminally (after the configured
 * retry attempts) or could not be read. Subclasses `GislError` — NOT
 * `GislApiError` — because it carries no contract error envelope and is
 * thrown from the multipart upload path, never from the response handler.
 * Mirrors the `GislAbortError` shape, plus the failing part's identifiers.
 */
export class GislMultipartPartError extends GislError {
  readonly partNumber: number;
  readonly uploadId: string;

  constructor(message: string, partNumber: number, uploadId: string) {
    super(message);
    this.name = 'GislMultipartPartError';
    this.partNumber = partNumber;
    this.uploadId = uploadId;
  }
}

/**
 * The upload would require more than the S3 hard limit of 10 000 multipart
 * parts at the server-provided chunk size. Client-side guard (Model A: the
 * server computes the part plan; the SDK asserts the ceiling). Subclasses
 * `GislError` for the same reason as `GislMultipartPartError`.
 */
export class GislMultipartPartCountError extends GislError {
  readonly requiredParts: number;
  readonly maxParts: number;

  constructor(message: string, requiredParts: number, maxParts: number) {
    super(message);
    this.name = 'GislMultipartPartCountError';
    this.requiredParts = requiredParts;
    this.maxParts = maxParts;
  }
}

/**
 * Thrown by the file-first `RunResult.byKey()` (FF1) when no result entry
 * matches the requested key. A keyless run (no `key:` supplied to `file()`)
 * is addressable positionally only — `byKey()` always throws.
 *
 * Mirrors the PHP `Gisl\Sdk\Errors\GislNoSuchKeyError`.
 */
export class GislNoSuchKeyError extends GislError {
  constructor(message: string) {
    super(message);
    this.name = 'GislNoSuchKeyError';
  }
}

/** Machine-readable cause carried by {@link GislSinkError}. */
export type GislSinkErrorReason =
  | 'not_single_output'
  | 'downloader_unavailable'
  | 'partial_failure'
  | 'duplicate_filename'
  | 'invalid_directory';

/**
 * Thrown by the file-first `RunResult` sinks (`toFile()` / `downloadTo()`,
 * FF1) when they cannot deliver. The machine-readable `reason` discriminates
 * the three cases, mirroring the `reason`-bag convention on
 * {@link GislConfigError}:
 *
 *  - `not_single_output`      — `toFile()` requires exactly one output but the
 *                               run produced zero or more than one.
 *  - `downloader_unavailable` — the `RunResult` has no downloader bound (e.g. a
 *                               browser / no-I/O context).
 *  - `partial_failure`        — `downloadTo({ failOnPartial: true })` and the
 *                               run had at least one failed input.
 *  - `duplicate_filename`     — two outputs share a destination filename in one
 *                               `downloadTo(dir)`, which would silently overwrite.
 *
 * Mirrors the PHP `Gisl\Sdk\Errors\GislSinkError`.
 */
export class GislSinkError extends GislError {
  readonly reason: GislSinkErrorReason;

  constructor(message: string, options: { readonly reason: GislSinkErrorReason }) {
    super(message);
    this.name = 'GislSinkError';
    this.reason = options.reason;
  }
}
