import type { AuthErrorResponse, AuthRejectionEnvelope, AuthRejectionEnvelopeErrorTypeEnum, BalanceExhaustedResponse, FeatureNotAvailableResponse, FeatureTierRestrictedResponse, LongFormConcurrencyLimitResponse, ProbePendingResponse, TierRestrictionResponse, UploadDurationExceedsTierResponse, UploadSizeExceedsTierResponse, WorkflowExpiredResponse } from '@giveitsmaller/contracts/openapi';
import type { ErrorCategory } from './generated/sdk_spec/errors.js';
import type { RateLimitSnapshot } from './retry-metadata.js';
export declare class GislError extends Error {
    constructor(message: string);
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
    /**
     * The wire-stable machine error code (the response envelope's `error` field,
     * SCREAMING_SNAKE, never localised). See {@link GislApiError.errorCode}.
     */
    readonly errorCode?: string;
    /**
     * The response headers from the HTTP response that produced this error.
     * Keys are LOWERCASED (HTTP header names are case-insensitive per RFC 9110,
     * and `Headers.forEach` yields lowercased keys). Multi-value headers (e.g.
     * `set-cookie`) are collapsed to a single comma-joined string — do NOT rely
     * on this map for cookies.
     */
    readonly responseHeaders?: Record<string, string>;
    /**
     * The resolved language the server reported via the `Content-Language`
     * response header. DISTINCT from `locale`, which is the body-envelope
     * localisation tag (the I26 `ErrorEnvelope.locale` field); `contentLanguage`
     * is the transport-level header the server echoes for content negotiation.
     */
    readonly contentLanguage?: string;
}
export declare class GislApiError extends GislError {
    readonly statusCode: number;
    readonly errorMessage: string;
    /**
     * The wire-stable machine error code — the response envelope's `error` field
     * (SCREAMING_SNAKE, never localised). DISTINCT from {@link errorMessage},
     * which is the human `message`. Mirrors the PHP `GislApiError.errorCode`.
     *
     * Optional here (PHP's is a required field defaulting to `'unknown_error'`):
     * a DELIBERATE optional-vs-sentinel divergence — `undefined` when the wire
     * envelope carries no `error` (e.g. a non-JSON / invalid-JSON response). When
     * the wire DOES carry `error`, both SDKs surface the same value. Machine
     * dispatch still keys off the typed subclasses (`payload.errorType`); this is
     * the flat machine code for a base `GislApiError` (e.g. a plain 404).
     */
    readonly errorCode?: string;
    readonly path?: string;
    readonly details?: unknown;
    readonly messageKey?: string;
    readonly locale?: string;
    readonly messageParams?: Record<string, unknown>;
    readonly payload?: unknown;
    /**
     * Response headers from the HTTP response that produced this error, with
     * LOWERCASED keys (RFC 9110 case-insensitive). Multi-value headers such as
     * `set-cookie` are collapsed into a single comma-joined string — don't rely
     * on this map for cookies.
     */
    readonly responseHeaders?: Record<string, string>;
    /**
     * The `Content-Language` response header value (the language the server
     * actually resolved). DISTINCT from `locale`, which is the body-envelope
     * localisation tag.
     */
    readonly contentLanguage?: string;
    constructor(statusCode: number, errorMessage: string, path?: string, details?: unknown, options?: GislApiErrorOptions);
    /**
     * Resolve the generated `ERROR_CODES` entry for this error, SOURCE-AWARE
     * (plan D1). ~9 registry codes are keyed by the `error_type` discriminator
     * rather than the envelope `error` field, so try the typed discriminator
     * FIRST (camel `errorType`, raw-snake `error_type` fallback), then fall back
     * to the flat machine {@link errorCode}. Returns `undefined` when neither
     * resolves — e.g. a bare base error whose payload carries no discriminator.
     * NEVER throws on a missing payload / discriminator.
     */
    private resolveErrorEntry;
    /**
     * Whether retrying this request could plausibly succeed. `true` when the HTTP
     * status is inherently retryable (408 / 429 / 5xx) OR the resolved taxonomy
     * entry marks the code retryable (e.g. `probe_pending`). Note: logical OR
     * (not `??`) — a 429 is retryable regardless of the taxonomy, and a
     * registry-retryable code is retryable regardless of status.
     */
    get retryable(): boolean;
    /**
     * The taxonomy category for this error's machine code, from the generated
     * `ERROR_CODES` registry, or `undefined` when the code isn't in the registry
     * (e.g. a bare base error whose payload carries no discriminator).
     */
    get category(): ErrorCategory | undefined;
    /**
     * The rate-limit snapshot parsed from the `x-ratelimit-*` response headers,
     * or `undefined` when they aren't all present as non-negative integers. Read
     * this after a 429 to schedule a back-off.
     */
    get rateLimit(): RateLimitSnapshot | undefined;
    /**
     * The server-suggested back-off delay in whole seconds, parsed from the
     * `Retry-After` response header, or `undefined` when absent / zero / past /
     * malformed. Mirrors the retry-loop parser's semantics.
     */
    get retryAfterSeconds(): number | undefined;
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
export declare class GislValidationError extends GislApiError {
    readonly details: GislValidationDetail[];
    constructor(statusCode: number, errorMessage: string, details: GislValidationDetail[], path?: string, options?: GislApiErrorOptions);
}
export declare class GislBalanceExhaustedError extends GislApiError {
    readonly payload: BalanceExhaustedResponse;
    constructor(statusCode: number, errorMessage: string, payload: BalanceExhaustedResponse, path?: string, extra?: Omit<GislApiErrorOptions, 'payload'>);
}
/**
 * `429` on `POST /api/workflows` when the caller already holds the maximum
 * number of concurrent in-flight long-form (Fargate) workflows their tier
 * permits (Pro 2 / Max 5; Enterprise uncapped). DISTINCT from an infrastructure
 * rate-limit `429`: it carries the machine code `LONG_FORM_CONCURRENCY_LIMIT_EXCEEDED`
 * and a `links.upgrade` deep link, and has **no `Retry-After`** — the limit clears
 * when an in-flight long-form workflow finishes, not on a timer. A generic infra
 * rate-limit `429` (no matching code) surfaces as the base {@link GislApiError}
 * instead, where {@link GislApiError.retryAfterSeconds} applies.
 *
 * Dispatched on the `error` CODE, not `error_type` (the envelope carries none).
 *
 * @example
 * try {
 *   await client.createWorkflow({ jobs });
 * } catch (e) {
 *   if (e instanceof GislLongFormConcurrencyError) {
 *     showUpgradeCta(e.upgradeUrl); // wait on completion or upgrade — do NOT back off
 *   }
 *   throw e;
 * }
 */
export declare class GislLongFormConcurrencyError extends GislApiError {
    readonly payload: LongFormConcurrencyLimitResponse;
    constructor(statusCode: number, errorMessage: string, payload: LongFormConcurrencyLimitResponse, path?: string, extra?: Omit<GislApiErrorOptions, 'payload'>);
    /**
     * ALWAYS `false`, overriding the base 429-implies-retryable heuristic
     * (UO1xYecu). This 429 is not a rate limit: it carries no `Retry-After` and
     * clears only when an in-flight long-form workflow finishes, so a back-off
     * retries into a wall that no amount of waiting-then-retrying opens. The base
     * accessor reported `true` purely from the status, contradicting this class's
     * own documented handling ("wait on completion or upgrade — do NOT back off")
     * and instructing the one recovery that cannot work.
     *
     * Overridden per-class rather than via a code table because this is the only
     * such code today; the general fix — an explicit taxonomy verdict outranking
     * the status heuristic — arrives with the `error-taxonomy.yaml` `retryable`
     * enum (contracts `plwcAqBr`), tracked on UO1xYecu.
     */
    get retryable(): boolean;
    /** The pricing / upgrade deep link (`links.upgrade`), or `undefined` when absent. */
    get upgradeUrl(): string | undefined;
}
export declare class GislTierRestrictedError extends GislApiError {
    readonly payload: TierRestrictionResponse;
    constructor(statusCode: number, errorMessage: string, payload: TierRestrictionResponse, path?: string, extra?: Omit<GislApiErrorOptions, 'payload'>);
}
export declare class GislFeatureTierRestrictedError extends GislApiError {
    readonly payload: FeatureTierRestrictedResponse;
    constructor(statusCode: number, errorMessage: string, payload: FeatureTierRestrictedResponse, path?: string, extra?: Omit<GislApiErrorOptions, 'payload'>);
}
export declare class GislFeatureNotAvailableError extends GislApiError {
    readonly payload: FeatureNotAvailableResponse;
    constructor(statusCode: number, errorMessage: string, payload: FeatureNotAvailableResponse, path?: string, extra?: Omit<GislApiErrorOptions, 'payload'>);
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
export declare class GislProbePendingError extends GislApiError {
    readonly payload: ProbePendingResponse;
    constructor(statusCode: number, errorMessage: string, payload: ProbePendingResponse, path?: string, extra?: Omit<GislApiErrorOptions, 'payload'>);
}
export declare class GislWorkflowExpiredError extends GislApiError {
    readonly payload: WorkflowExpiredResponse;
    constructor(statusCode: number, errorMessage: string, payload: WorkflowExpiredResponse, path?: string, extra?: Omit<GislApiErrorOptions, 'payload'>);
}
export declare class GislAuthError extends GislApiError {
    readonly payload: AuthErrorResponse;
    constructor(statusCode: number, errorMessage: string, payload: AuthErrorResponse, path?: string, extra?: Omit<GislApiErrorOptions, 'payload'>);
}
/**
 * 422 Unprocessable Entity — domain rejection on auth side-effect endpoints
 * (register / verify-email / api-keys duplicate-or-invalid; profile PATCH email
 * unchanged). Flat `AuthRejectionEnvelope`, no `details[]`. Mirrors the PHP
 * `Gisl\Sdk\Errors\GislAuthRejectionError`.
 *
 * `payload.errorType` is the auth-422 `oneOf` discriminator
 * (`unprocessable_entity` or `email_same`); `errorType` re-exposes it directly
 * for caller-side narrowing without unwrapping the typed payload. Distinct from
 * `GislValidationError` (the `validation_error` branch of the same `oneOf`,
 * which carries `details[]`).
 */
export declare class GislAuthRejectionError extends GislApiError {
    readonly payload: AuthRejectionEnvelope;
    readonly errorType: AuthRejectionEnvelopeErrorTypeEnum;
    constructor(statusCode: number, errorMessage: string, payload: AuthRejectionEnvelope, path?: string, extra?: Omit<GislApiErrorOptions, 'payload'>);
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
export type GislUploadCapKind = 'size_tier' | 'duration_tier' | 'absolute_413' | 'cap_v2_multipart';
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
export declare class GislUploadCapExceededError extends GislApiError {
    readonly kind: GislUploadCapKind;
    readonly payload: UploadSizeExceedsTierResponse | UploadDurationExceedsTierResponse | undefined;
    constructor(statusCode: number, errorMessage: string, kind: GislUploadCapKind, payload: UploadSizeExceedsTierResponse | UploadDurationExceedsTierResponse | undefined, path?: string, extra?: Omit<GislApiErrorOptions, 'payload'>);
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
export declare class GislMultipartSessionNotFoundError extends GislApiError {
    constructor(statusCode: number, errorMessage: string, path?: string, options?: GislApiErrorOptions);
}
/**
 * 403 `MULTIPART_SESSION_OWNERSHIP` — the caller is authenticated but the
 * multipart session belongs to a different user. Thrown by the SDK-3
 * resume-support endpoints. The session itself exists (otherwise the server
 * would return 404 NOT_FOUND); the caller's identity simply doesn't match
 * `manifest.userId`. Consumers should abandon the resume.
 */
export declare class GislMultipartSessionOwnershipError extends GislApiError {
    constructor(statusCode: number, errorMessage: string, path?: string, options?: GislApiErrorOptions);
}
/**
 * 403 `MULTIPART_SESSION_AUTH_REQUIRED` — the multipart session was initiated
 * anonymously (no `manifest.userId`) and the SDK-3 resume-support endpoints
 * refuse to serve it on an authed caller. There is no "claim" workflow today
 * to bind an authed identity to an anonymously-started session; that is the
 * future flip tracked at upstream ticket 8LABloaz. Consumers hitting this on
 * resume should abandon and re-upload from scratch under the authed identity.
 */
export declare class GislMultipartSessionAuthRequiredError extends GislApiError {
    constructor(statusCode: number, errorMessage: string, path?: string, options?: GislApiErrorOptions);
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
export declare class GislConfigError extends GislError {
    readonly reason?: string;
    readonly conflictingFields?: readonly string[];
    readonly resolvedSnapshot?: Readonly<Record<string, unknown>>;
    readonly suggestion?: string;
    constructor(message: string, metadata?: GislConfigErrorMetadata);
}
/**
 * The ergonomic-layer factory `gisl.create()` could not resolve an API key
 * from any of explicit arg, `GISL_API_KEY` env, or shared-config profile,
 * AND the caller did not opt into anonymous or cookie-mode. Thrown BEFORE
 * any file read or HTTP request — calls to `client.compress(...)`, `.run()`,
 * etc., synchronously fail with this error.
 */
export declare class GislMissingCredentialsError extends GislConfigError {
    constructor(message: string);
}
/**
 * `streamEvents` was called on a client whose configuration has **no declared
 * SSE stream host**. Local-only — thrown before any I/O.
 *
 * ⚠️ **THIS ERROR IS A CONTROL, NOT A DEFECT.** The stream lives on a second
 * host, and the SDK will not guess it from `baseUrl`. Deriving `stream.*` from
 * `api.*` by string surgery is a *convention*, and a convention is precisely
 * what put production on the gateway path: the frontend's prod build had no
 * stream host configured, fell back to the API host silently, and the failure
 * was invisible until it was measured. Raising here is the loud version of
 * that same situation.
 *
 * Both named environments resolve as of contracts `v2.195.0` (#410), which
 * declared the production stream host. This now fires only for a
 * configuration nothing declares — e.g. a bare `baseUrl` with no
 * `environment` and no `streamBaseUrl`.
 *
 * Recover by passing `{streamBaseUrl}` to `gisl.create()` / `new GislClient()`,
 * setting `GISL_STREAM_BASE_URL`, or constructing with an `{environment}` that
 * declares one. `run()` does NOT surface this error — it treats an undeclared
 * stream host as "SSE unavailable for this configuration" and polls instead.
 */
export declare class GislStreamHostNotDeclaredError extends GislConfigError {
    constructor(message: string);
}
/**
 * The caller used `gisl.anonymous()` and then invoked an operation that is
 * not in the anonymous-capable allowlist. Local-only — thrown before any I/O.
 * Distinct from server-side `GislAuthError` (401/403 on the wire).
 */
export declare class GislFeatureRequiresAuthError extends GislConfigError {
    readonly operation: string;
    constructor(operation: string, message: string);
}
/**
 * `MergeBuilder.sequence(...)` referenced an asset that wasn't declared in
 * the prior `client.merge(...)` call. Local validation runs BEFORE upload
 * so the caller fails fast on the typo without burning bandwidth.
 */
export declare class GislUndeclaredAssetError extends GislConfigError {
    readonly assetId: string;
    readonly declaredAssets: readonly string[];
    constructor(assetId: string, declaredAssets: readonly string[]);
}
/**
 * `MergeBuilder.sequence(...)` was called but at least one declared asset
 * wasn't referenced. Almost always a bug (wasted upload). Escape via
 * `allowUnusedAssets: true` on the merge options.
 */
export declare class GislUnusedAssetError extends GislConfigError {
    readonly unusedAssets: readonly string[];
    constructor(unusedAssets: readonly string[]);
}
/**
 * `MergeBuilder.sequence(...)` on an image merge was given a `clip(ref, opts)`
 * entry. Image merges have NO per-input options in the wire today — `transition`
 * applies at the merge level and is uniform across all joins.
 */
export declare class GislPerInputOptionsNotSupportedError extends GislConfigError {
    readonly mediaKind: string;
    constructor(mediaKind: string);
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
export declare class GislChainCardinalityMismatchError extends GislConfigError {
    readonly previousOperation: string;
    readonly attemptedOperation: string;
    constructor(previousOperation: string, attemptedOperation: string);
}
/**
 * Thrown by `.bundle(...)` when the target builder's terminal job is already an
 * `archive` op — double-bundle prevention (a builder that already produces an
 * archive cannot be bundled again). No HTTP: raised during lowering, before any
 * upload. Per the lowering spec
 * (`docs/plans/sdk-ergonomics/lowering.md:484`, id `bundle_already_archived_error`).
 * Dormant until `.bundle()` ships (wpHoJhuo) — the type lands here so that PR is
 * a pure addition.
 */
export declare class GislBundleAlreadyArchivedError extends GislConfigError {
    constructor();
}
export declare class GislTimeoutError extends GislError {
    /**
     * The workflow this timeout is scoped to, when the SDK knows it. Set on a
     * timed-out `run()` / `wait()` / poll / download once the workflow has been
     * created: a timeout does NOT mean the work failed — the server keeps
     * processing, so poll `client.getWorkflowStatus(workflowId)` /
     * `getWorkflowDownloads(workflowId)` to recover a result that completed after
     * the deadline, instead of re-running (a re-run re-uploads and, for
     * authenticated callers, settles a SECOND charge for the same deliverable).
     *
     * `undefined` when the SDK has no id to offer. That is NOT a guarantee that
     * nothing was created or charged: it covers both the safe case (an upload /
     * probe timeout before any workflow existed) AND the AMBIGUOUS case (the
     * `POST /api/workflows` request itself timed out — the server may have
     * created and charged the workflow before its response was lost). Treat an
     * absent id as "cannot auto-recover", not "clean slate": reconcile (e.g. list
     * recent workflows) before re-running rather than assuming nothing happened.
     */
    readonly workflowId?: string;
    constructor(message: string, workflowId?: string);
}
/**
 * A `mapEach` fan-out timed out mid-batch — the deadline elapsed either while a
 * child was still running (the common case) or cleanly between child runs. The
 * parent and some children have ALREADY completed, so re-running the whole batch
 * re-does finished work. This carries their ids so the caller can poll them (via
 * `client.getWorkflowStatus` / `getWorkflowDownloads`) to recover the finished
 * work and re-run ONLY the children that were never created.
 *
 * Subclasses {@link GislTimeoutError}, so an existing
 * `catch (e) { if (e instanceof GislTimeoutError) … }` still catches it. The
 * inherited `workflowId` carries the IN-FLIGHT child — the one that was running
 * when the deadline elapsed (a child's own timeout, the common path) — or stays
 * `undefined` when the deadline elapsed cleanly BETWEEN children (no in-flight
 * child). To recover, poll `workflowId` (if set) + {@link parentWorkflowId} +
 * {@link completedWorkflowIds}, then re-run only the children that never started.
 *
 * NOTE on double-charge: the server-side create-dedupe (DSxwCetg) is what
 * prevents a byte-identical child re-create from settling a SECOND charge within
 * the dedup window; this error's job is efficient RECOVERY (skip the completed
 * work) + defense-in-depth, not the sole charge guard.
 */
export declare class GislFanOutTimeoutError extends GislTimeoutError {
    /** The child workflows that completed before the deadline elapsed. */
    readonly completedWorkflowIds: readonly string[];
    /** The parent workflow, which ran to completion before the fan-out began. */
    readonly parentWorkflowId?: string;
    constructor(message: string, opts: {
        completedWorkflowIds: readonly string[];
        parentWorkflowId?: string;
        /**
         * The in-flight child that timed out mid-run (its own deadline elapsed);
         * `undefined` for a clean between-children timeout with no child running.
         */
        workflowId?: string;
        /** The underlying child {@link GislTimeoutError}, preserved for chaining. */
        cause?: unknown;
    });
}
/**
 * Base for every failure that happened **off the contract envelope** — the
 * request did not come back as a typed API error, it came back (or failed to)
 * at the transport or raw-HTTP level. Subclasses `GislError` rather than
 * `GislApiError` because there is no error envelope to carry.
 *
 * ⚠️ **NEVER THROWN DIRECTLY — it is a hierarchy node, not an error code
 * (`t2qCrjdr`).** Everything that used to throw it now throws
 * {@link GislTransportError} or {@link GislDownloadHttpError}, because the two
 * cases cannot share one honest answer to "should I retry this?":
 *
 * | case | retry? |
 * |---|---|
 * | DNS / TCP / TLS / mid-stream disconnect | **yes** — transient by nature |
 * | a `404` on a signed download URL | **no** — permanent, retrying burns time |
 *
 * `retryable: true` would recommend retrying a permanent failure and
 * `retryable: false` would discourage retrying a genuine transient one, so
 * contracts correctly refused to declare this class in
 * `sdk-spec/error-taxonomy.yaml` at all. The fix is the split, not a caveat in
 * a description field: **a claim must hold on every path that reaches it.**
 *
 * **Kept as the base ON PURPOSE, so this is not a breaking change.** Every
 * existing `catch (e) { if (e instanceof GislNetworkError) … }` — including the
 * SSE poll-fallback in `builder.ts` / `merge.ts` / `handle.ts` /
 * `file-first.ts` — keeps catching exactly what it caught before. Narrow to a
 * subclass only where you actually need to tell the two apart.
 *
 * Mirrors the PHP `Gisl\Sdk\Errors\GislNetworkError`.
 */
export declare class GislNetworkError extends GislError {
    constructor(message: string);
}
/**
 * The transport could not deliver a usable response: DNS, TCP, TLS, a
 * mid-stream disconnect, a `fetch` rejection, or a 2xx that arrived with no
 * body at all. **Always retryable** — nothing about these says the request was
 * wrong, only that it did not get through.
 *
 * The empty-body case lives here rather than with
 * {@link GislDownloadHttpError} deliberately: the server said 2xx, so it is not
 * an HTTP-level refusal — a response that promised bytes and delivered none is
 * a delivery failure, and retrying is the right advice.
 *
 * The concrete file-first `Downloader` raises this when an output URL cannot be
 * read (a destination-WRITE failure is `GislSinkError` reason `write_failed`).
 */
export declare class GislTransportError extends GislNetworkError {
    constructor(message: string);
    /**
     * Always `true`. The request did not get through; nothing about that says it
     * was wrong, so retrying is the correct advice.
     *
     * Present as a real accessor rather than only as prose — an unbacked claim in
     * a docblock is the exact defect `t2qCrjdr` exists to remove, and shipping
     * the split without it would have reproduced it one level down.
     */
    get retryable(): boolean;
}
/**
 * The request was never put on the wire because the client refused to send it —
 * a malformed URI or an otherwise unsendable request. **Never retryable:**
 * re-issuing the identical request fails identically, so backing off only
 * wastes the caller's deadline.
 *
 * ⚠️ **THE TWO LANGUAGES DETECT THIS DIFFERENTLY, AND TS DETECTS LESS.** PSR-18
 * distinguishes a network failure (`NetworkExceptionInterface`) from an
 * unsendable request (`RequestExceptionInterface`), so the PHP SDK classifies
 * every such failure. `fetch` surfaces both as an indistinguishable
 * `TypeError`, so the TS SDK can only catch the cases it can see BEFORE the
 * call — today, a URL that does not parse (`http-downloader`). A `fetch`
 * rejection is still reported as {@link GislTransportError}, because guessing
 * would put a permanent failure back in the retryable bucket, which is the very
 * thing this split removed.
 *
 * So: same class, same meaning, same `retryable` in both SDKs — narrower
 * detection in TypeScript. Stated here because a cross-language consumer would
 * otherwise reasonably assume parity of COVERAGE from parity of TYPE.
 */
export declare class GislRequestNotSentError extends GislNetworkError {
    constructor(message: string);
    /** Always `false` — the request never left, and re-sending it will not change that. */
    get retryable(): boolean;
}
/**
 * A download URL answered with a **non-2xx status**. The server was reached and
 * replied; it simply refused. Distinct from {@link GislTransportError} because
 * retrying is usually pointless — and `retryable` says so honestly, derived
 * from the status rather than fixed for the class.
 *
 * `status` is carried as a field so a consumer distinguishing a permanent `404`
 * from a transient `503` does not have to parse the message string — the second
 * half of `t2qCrjdr`.
 *
 * Raised on result-download fetches (signed URLs), NOT on GISL-API calls: an
 * API non-2xx carries a contract error envelope and surfaces as the matching
 * {@link GislApiError} subclass instead.
 */
export declare class GislDownloadHttpError extends GislNetworkError {
    /** The HTTP status the download URL responded with. */
    readonly status: number;
    constructor(message: string, status: number);
    /**
     * Whether retrying this download could plausibly succeed. Derived from the
     * status by the same rule the API errors use (`408` / `429` / `5xx`), so a
     * `404` reports `false` and a `503` reports `true` — the distinction the
     * unsplit class could not express.
     */
    get retryable(): boolean;
}
/**
 * Internal control-flow marker (TDqmkWpX): the SSE event stream closed cleanly
 * WITHOUT a terminal (`workflow_completed`/`failed`/`partially_failed`) event.
 * Raised by {@link _consumeSseToTerminal} so the await-terminal callers can
 * distinguish a benign server-side stream close (→ fall back to polling) from a
 * genuine failure that must propagate (an `onProgress` callback throw, an API
 * error, a caller abort). Mirrors the PHP `SseStreamEndedWithoutTerminal`
 * sealed marker. Not part of the public error contract — never surfaced to a
 * caller (the await-terminal path catches it internally and polls).
 */
export declare class SseEndedWithoutTerminal extends GislError {
    constructor(message?: string);
}
export declare class GislAbortError extends GislError {
    constructor(message: string);
}
/**
 * A single S3 multipart part PUT failed terminally (after the configured
 * retry attempts) or could not be read. Subclasses `GislError` — NOT
 * `GislApiError` — because it carries no contract error envelope and is
 * thrown from the multipart upload path, never from the response handler.
 * Mirrors the `GislAbortError` shape, plus the failing part's identifiers.
 */
export declare class GislMultipartPartError extends GislError {
    readonly partNumber: number;
    readonly uploadId: string;
    constructor(message: string, partNumber: number, uploadId: string);
}
/**
 * The upload would require more than the S3 hard limit of 10 000 multipart
 * parts at the server-provided chunk size. Client-side guard (Model A: the
 * server computes the part plan; the SDK asserts the ceiling). Subclasses
 * `GislError` for the same reason as `GislMultipartPartError`.
 */
export declare class GislMultipartPartCountError extends GislError {
    readonly requiredParts: number;
    readonly maxParts: number;
    constructor(message: string, requiredParts: number, maxParts: number);
}
/**
 * Thrown by the file-first `RunResult.byKey()` (FF1) when no result entry
 * matches the requested key. A keyless run (no `key:` supplied to `file()`)
 * is addressable positionally only — `byKey()` always throws.
 *
 * Mirrors the PHP `Gisl\Sdk\Errors\GislNoSuchKeyError`.
 */
export declare class GislNoSuchKeyError extends GislError {
    constructor(message: string);
}
/**
 * Thrown by the file-first `Handle.result()` (FF5a) when the workflow has not
 * yet reached a terminal state. `result()` is the NON-blocking accessor: it
 * fetches the current status once and, if the workflow is still
 * `pending`/`in_progress`, throws this rather than waiting. Use `Handle.wait()`
 * to block until terminal instead.
 *
 * Carries the `workflowId` and the current (non-terminal) `state`.
 *
 * Mirrors the PHP `Gisl\Sdk\Errors\GislResultNotReadyError`.
 */
export declare class GislResultNotReadyError extends GislError {
    readonly workflowId: string;
    readonly state: string;
    constructor(workflowId: string, state: string);
}
/** Machine-readable cause carried by {@link GislSinkError}. */
export type GislSinkErrorReason = 'not_single_output' | 'downloader_unavailable' | 'partial_failure' | 'duplicate_filename' | 'invalid_directory' | 'write_failed';
/**
 * Thrown by the file-first `RunResult` sinks (`toFile()` / `downloadTo()`,
 * FF1) when they cannot deliver. The machine-readable `reason` discriminates
 * the six cases below, mirroring the `reason`-bag convention on
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
 *  - `write_failed`           — a concrete {@link Downloader} could not open or
 *                               stream to the destination path.
 *
 * Mirrors the PHP `Gisl\Sdk\Errors\GislSinkError`.
 */
export declare class GislSinkError extends GislError {
    readonly reason: GislSinkErrorReason;
    constructor(message: string, options: {
        readonly reason: GislSinkErrorReason;
    });
}
/**
 * A terminal item failure in {@link RunResult.failed} — an input whose job did
 * not reach `completed`. Stored in `ItemFailure.error` so a caller can branch on
 * the failure reason WITHOUT string-parsing.
 *
 * - `state`: the terminal lifecycle state (`failed` / `expired` / `cancelled` /
 *   `partially_failed` / `paused_insufficient_credits`, or a per-job
 *   non-`completed` status).
 * - `errorMessage` / `errorCode`: the human + machine fields read from the first
 *   failing operation (`OperationResponse.error_message` / `.error_code`). BOTH
 *   are absent for non-`failed` terminal states — cancel / expire / credit-pause
 *   carry only the bare `state`.
 *
 * `message` is `state` optionally suffixed `: errorMessage`, preserving the
 * pre-typed string exactly (an empty-string `errorMessage` still adds the colon).
 *
 * Mirrors the PHP `Gisl\Sdk\Errors\GislItemFailedError`.
 */
export declare class GislItemFailedError extends GislError {
    readonly key: string | null;
    readonly state: string;
    readonly errorMessage?: string;
    readonly errorCode?: string;
    constructor(key: string | null, state: string, errorMessage?: string, errorCode?: string);
}
