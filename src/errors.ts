import type {
  AuthErrorResponse,
  BalanceExhaustedResponse,
  FeatureNotAvailableResponse,
  FeatureTierRestrictedResponse,
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
 * Root of the LOCAL config-error tree — thrown before any HTTP/file I/O.
 * Sibling of `GislApiError` (which represents server-side error envelopes).
 * Reserve for fail-early errors raised by the ergonomic-layer factory or
 * credential-chain resolver when the caller hasn't supplied something the
 * SDK needs to make a request. Never carries an HTTP status code.
 */
export class GislConfigError extends GislError {
  constructor(message: string) {
    super(message);
    this.name = 'GislConfigError';
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
