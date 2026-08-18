// W8v4jWzx — the generated error-taxonomy registry stays INTERNAL to this
// module (only the `ErrorCategory` TYPE is re-exported from the public barrel).
import { ERROR_CODES } from './generated/sdk_spec/errors.js';
import { isApiRetryableStatus, rateLimitFromHeaders, retryAfterSecondsFromHeaders, } from './retry-metadata.js';
// Registry keys are lowercase_snake; normalise the wire code / discriminator
// (trim + lowercase) before looking it up in ERROR_CODES.
function normalizeErrorCode(rawCode) {
    return rawCode.trim().toLowerCase();
}
export class GislError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GislError';
    }
}
export class GislApiError extends GislError {
    statusCode;
    errorMessage;
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
    errorCode;
    path;
    details;
    messageKey;
    locale;
    messageParams;
    payload;
    /**
     * Response headers from the HTTP response that produced this error, with
     * LOWERCASED keys (RFC 9110 case-insensitive). Multi-value headers such as
     * `set-cookie` are collapsed into a single comma-joined string — don't rely
     * on this map for cookies.
     */
    responseHeaders;
    /**
     * The `Content-Language` response header value (the language the server
     * actually resolved). DISTINCT from `locale`, which is the body-envelope
     * localisation tag.
     */
    contentLanguage;
    constructor(statusCode, errorMessage, path, details, options) {
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
            this.errorCode = options.errorCode;
            this.responseHeaders = options.responseHeaders;
            this.contentLanguage = options.contentLanguage;
        }
    }
    /**
     * Resolve the generated `ERROR_CODES` entry for this error, SOURCE-AWARE
     * (plan D1). ~9 registry codes are keyed by the `error_type` discriminator
     * rather than the envelope `error` field, so try the typed discriminator
     * FIRST (camel `errorType`, raw-snake `error_type` fallback), then fall back
     * to the flat machine {@link errorCode}. Returns `undefined` when neither
     * resolves — e.g. a bare base error whose payload carries no discriminator.
     * NEVER throws on a missing payload / discriminator.
     */
    resolveErrorEntry() {
        const payload = this.payload;
        const rawErrorType = payload?.errorType ?? payload?.error_type;
        if (typeof rawErrorType === 'string') {
            const byType = ERROR_CODES[normalizeErrorCode(rawErrorType)];
            if (byType !== undefined)
                return byType;
        }
        if (this.errorCode !== undefined) {
            const byCode = ERROR_CODES[normalizeErrorCode(this.errorCode)];
            if (byCode !== undefined)
                return byCode;
        }
        return undefined;
    }
    /**
     * Whether retrying this request could plausibly succeed. `true` when the HTTP
     * status is inherently retryable (408 / 429 / 5xx) OR the resolved taxonomy
     * entry marks the code retryable (e.g. `probe_pending`). Note: logical OR
     * (not `??`) — a 429 is retryable regardless of the taxonomy, and a
     * registry-retryable code is retryable regardless of status.
     */
    get retryable() {
        return (isApiRetryableStatus(this.statusCode) || (this.resolveErrorEntry()?.retryable ?? false));
    }
    /**
     * The taxonomy category for this error's machine code, from the generated
     * `ERROR_CODES` registry, or `undefined` when the code isn't in the registry
     * (e.g. a bare base error whose payload carries no discriminator).
     */
    get category() {
        return this.resolveErrorEntry()?.category;
    }
    /**
     * The rate-limit snapshot parsed from the `x-ratelimit-*` response headers,
     * or `undefined` when they aren't all present as non-negative integers. Read
     * this after a 429 to schedule a back-off.
     */
    get rateLimit() {
        return rateLimitFromHeaders(this.responseHeaders);
    }
    /**
     * The server-suggested back-off delay in whole seconds, parsed from the
     * `Retry-After` response header, or `undefined` when absent / zero / past /
     * malformed. Mirrors the retry-loop parser's semantics.
     */
    get retryAfterSeconds() {
        return retryAfterSecondsFromHeaders(this.responseHeaders);
    }
}
export class GislValidationError extends GislApiError {
    constructor(statusCode, errorMessage, details, path, options) {
        super(statusCode, errorMessage, path, details, options);
        this.name = 'GislValidationError';
    }
}
// Shared constructor body for the structured-payload subclasses. Five of the
// six subclasses below differ only in their typed `payload` and `name` —
// factor the common construction here so each subclass remains a one-liner.
function buildOptionsWithPayload(payload, extra) {
    return { ...extra, payload };
}
export class GislBalanceExhaustedError extends GislApiError {
    constructor(statusCode, errorMessage, payload, path, extra) {
        super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
        this.name = 'GislBalanceExhaustedError';
    }
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
export class GislLongFormConcurrencyError extends GislApiError {
    constructor(statusCode, errorMessage, payload, path, extra) {
        super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
        this.name = 'GislLongFormConcurrencyError';
    }
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
    get retryable() {
        return false;
    }
    /** The pricing / upgrade deep link (`links.upgrade`), or `undefined` when absent. */
    get upgradeUrl() {
        return this.payload.links?.upgrade;
    }
}
export class GislTierRestrictedError extends GislApiError {
    constructor(statusCode, errorMessage, payload, path, extra) {
        super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
        this.name = 'GislTierRestrictedError';
    }
}
export class GislFeatureTierRestrictedError extends GislApiError {
    constructor(statusCode, errorMessage, payload, path, extra) {
        super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
        this.name = 'GislFeatureTierRestrictedError';
    }
}
export class GislFeatureNotAvailableError extends GislApiError {
    constructor(statusCode, errorMessage, payload, path, extra) {
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
    constructor(statusCode, errorMessage, payload, path, extra) {
        super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
        this.name = 'GislProbePendingError';
    }
}
export class GislWorkflowExpiredError extends GislApiError {
    constructor(statusCode, errorMessage, payload, path, extra) {
        super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
        this.name = 'GislWorkflowExpiredError';
    }
}
export class GislAuthError extends GislApiError {
    constructor(statusCode, errorMessage, payload, path, extra) {
        super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
        this.name = 'GislAuthError';
    }
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
export class GislAuthRejectionError extends GislApiError {
    errorType;
    constructor(statusCode, errorMessage, payload, path, extra) {
        super(statusCode, errorMessage, path, undefined, buildOptionsWithPayload(payload, extra));
        this.name = 'GislAuthRejectionError';
        this.errorType = payload.errorType;
    }
}
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
    kind;
    constructor(statusCode, errorMessage, kind, payload, path, extra) {
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
    constructor(statusCode, errorMessage, path, options) {
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
    constructor(statusCode, errorMessage, path, options) {
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
    constructor(statusCode, errorMessage, path, options) {
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
 *
 * Optional `metadata` (T4b — `27rE1fZn`) carries structured fields used
 * by the preset resolver and other ergonomic-layer validators. Existing
 * call sites that pass `(message)` keep working — metadata is purely
 * additive and defaults to `undefined`.
 */
export class GislConfigError extends GislError {
    reason;
    conflictingFields;
    resolvedSnapshot;
    suggestion;
    constructor(message, metadata) {
        super(message);
        this.name = 'GislConfigError';
        if (metadata !== undefined) {
            if (metadata.reason !== undefined)
                this.reason = metadata.reason;
            if (metadata.conflictingFields !== undefined) {
                this.conflictingFields = metadata.conflictingFields;
            }
            if (metadata.resolvedSnapshot !== undefined) {
                this.resolvedSnapshot = metadata.resolvedSnapshot;
            }
            if (metadata.suggestion !== undefined)
                this.suggestion = metadata.suggestion;
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
    constructor(message) {
        super(message);
        this.name = 'GislMissingCredentialsError';
    }
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
 * Today this is reachable in a production configuration because the contract
 * declares stream `servers` for localhost and staging only — contracts
 * deliberately did not invent a prod URL. Once the prod entry lands, a prod
 * client resolves normally and this stops firing for that case.
 *
 * Recover by passing `{streamBaseUrl}` to `gisl.create()` / `new GislClient()`,
 * setting `GISL_STREAM_BASE_URL`, or constructing with an `{environment}` that
 * declares one. `run()` does NOT surface this error — it treats an undeclared
 * stream host as "SSE unavailable for this configuration" and polls instead.
 */
export class GislStreamHostNotDeclaredError extends GislConfigError {
    constructor(message) {
        super(message);
        this.name = 'GislStreamHostNotDeclaredError';
    }
}
/**
 * The caller used `gisl.anonymous()` and then invoked an operation that is
 * not in the anonymous-capable allowlist. Local-only — thrown before any I/O.
 * Distinct from server-side `GislAuthError` (401/403 on the wire).
 */
export class GislFeatureRequiresAuthError extends GislConfigError {
    operation;
    constructor(operation, message) {
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
    assetId;
    declaredAssets;
    constructor(assetId, declaredAssets) {
        super(`Sequence references asset '${assetId}' but it wasn't declared in merge(...). ` +
            `Declared assets: [${declaredAssets.join(', ')}]. ` +
            `Either pass it to merge(...) before sequencing, or remove the reference.`);
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
    unusedAssets;
    constructor(unusedAssets) {
        super(`Assets [${unusedAssets.join(', ')}] were declared in merge(...) but never sequenced. ` +
            `Reference them in .sequence(...), remove them from the declaration, ` +
            `or pass {allowUnusedAssets: true} to opt out of this check.`);
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
    mediaKind;
    constructor(mediaKind) {
        super(`${mediaKind} merge has no per-input options today; set 'transition' at the ` +
            `.merge(...) level instead — it applies to every join.`);
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
    previousOperation;
    attemptedOperation;
    constructor(previousOperation, attemptedOperation) {
        super(`Previous step (${previousOperation}) produces multiple artifacts; ` +
            `use .mapEach(art => art.${attemptedOperation}(...)) to apply the chain per-artifact, ` +
            `or branch to a single artifact first.`);
        this.name = 'GislChainCardinalityMismatchError';
        this.previousOperation = previousOperation;
        this.attemptedOperation = attemptedOperation;
    }
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
export class GislBundleAlreadyArchivedError extends GislConfigError {
    constructor() {
        super('This builder already produces an archive (bundle); .bundle() cannot be ' +
            'applied to an already-bundled builder.');
        this.name = 'GislBundleAlreadyArchivedError';
    }
}
export class GislTimeoutError extends GislError {
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
    workflowId;
    constructor(message, workflowId) {
        super(message);
        this.name = 'GislTimeoutError';
        // Normalise an empty id to "absent" — an empty string is not a usable
        // recovery handle (some throw sites derive the id as `… ?? ''`).
        this.workflowId = workflowId === '' ? undefined : workflowId;
    }
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
export class GislFanOutTimeoutError extends GislTimeoutError {
    /** The child workflows that completed before the deadline elapsed. */
    completedWorkflowIds;
    /** The parent workflow, which ran to completion before the fan-out began. */
    parentWorkflowId;
    constructor(message, opts) {
        // The inherited workflowId is the in-flight child (or undefined between children).
        super(message, opts.workflowId);
        this.name = 'GislFanOutTimeoutError';
        this.completedWorkflowIds = [...opts.completedWorkflowIds];
        this.parentWorkflowId = opts.parentWorkflowId === '' ? undefined : opts.parentWorkflowId;
        if (opts.cause !== undefined) {
            this.cause = opts.cause;
        }
    }
}
/**
 * Transport-level failure: the underlying `fetch` (or other transport) could
 * not produce a usable response — DNS, TCP, TLS, a mid-stream disconnect, or a
 * non-ok status / empty body when fetching a result download. Mirrors the PHP
 * `Gisl\Sdk\Errors\GislNetworkError`. Subclasses `GislError` (not
 * `GislApiError`) because it carries no contract error envelope. The concrete
 * file-first {@link Downloader} raises this when the output URL cannot be read
 * (a destination-WRITE failure is `GislSinkError` reason `write_failed`).
 */
export class GislNetworkError extends GislError {
    constructor(message) {
        super(message);
        this.name = 'GislNetworkError';
    }
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
export class SseEndedWithoutTerminal extends GislError {
    constructor(message = 'SSE stream ended without a terminal event') {
        super(message);
        this.name = 'SseEndedWithoutTerminal';
    }
}
export class GislAbortError extends GislError {
    constructor(message) {
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
    partNumber;
    uploadId;
    constructor(message, partNumber, uploadId) {
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
    requiredParts;
    maxParts;
    constructor(message, requiredParts, maxParts) {
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
    constructor(message) {
        super(message);
        this.name = 'GislNoSuchKeyError';
    }
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
export class GislResultNotReadyError extends GislError {
    workflowId;
    state;
    constructor(workflowId, state) {
        super(`Workflow ${workflowId} is not ready (state '${state}'); its result is not available yet. ` +
            'Call wait() to block until it reaches a terminal state, or poll result() again later.');
        this.name = 'GislResultNotReadyError';
        this.workflowId = workflowId;
        this.state = state;
    }
}
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
export class GislSinkError extends GislError {
    reason;
    constructor(message, options) {
        super(message);
        this.name = 'GislSinkError';
        this.reason = options.reason;
    }
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
export class GislItemFailedError extends GislError {
    key;
    state;
    errorMessage;
    errorCode;
    constructor(key, state, errorMessage, errorCode) {
        super(state + (errorMessage !== undefined ? `: ${errorMessage}` : ''));
        this.name = 'GislItemFailedError';
        this.key = key;
        this.state = state;
        if (errorMessage !== undefined)
            this.errorMessage = errorMessage;
        if (errorCode !== undefined)
            this.errorCode = errorCode;
    }
}
