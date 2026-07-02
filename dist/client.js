// node:fs/promises + node:path are reached only through `./node-fs.js`, which
// the package.json `browser` field swaps for a stub in browser bundles — so the
// SDK entry graph stays browser-safe (a browser caller uploads a Blob via
// blobByteSource, which never touches these). Kept as a STATIC import (not a
// dynamic one) so `vi.mock('node:fs/promises')` still intercepts it in tests.
import { open, stat, basename } from './node-fs.js';
import { AudioWatermarkDecodeRequestToJSON, AudioWatermarkDecodeResponseFromJSON, ExternalImportCreatedResponseFromJSON, ExternalImportRequestToJSON, LoginUser200ResponseDataFromJSON, AccountLimitsFromJSON, CreditsBalanceResponseFromJSON, CreditsUsageResponseFromJSON, UploadResponseFromJSON, UploadProbeResponseFromJSON, MultipartInitiateResponseFromJSON, MultipartInitiateRequestMetadataHintToJSON, MultipartCompleteResponseFromJSON, MultipartCompleteRequestToJSON, WorkflowCancelResponseFromJSON, WorkflowCreateResponseFromJSON, WorkflowResumeResponseFromJSON, WorkflowStatusResponseFromJSON, WorkflowListResponseFromJSON, WorkflowDownloadResponseFromJSON, MetadataResponseFromJSON, OperationsSchemaResponseFromJSON, RetryResponseFromJSON, WorkflowStatus, AuthErrorResponseFromJSON, AuthErrorType, AuthRejectionEnvelopeFromJSON, AuthRejectionEnvelopeErrorTypeEnum, BalanceExhaustedResponseFromJSON, BalanceExhaustedResponseRequiredActionEnum, FeatureNotAvailableResponseFromJSON, FeatureTierRestrictedResponseFromJSON, TierRestrictionKind, TierRestrictionResponseFromJSON, UserTier, WorkflowExpiredResponseFromJSON, ProbePendingResponseFromJSON, UploadSizeExceedsTierResponseFromJSON, UploadDurationExceedsTierResponseFromJSON, UploadConstraintsAppliedProcessingClassPreAssignmentEnum, UploadThresholdsSingleShotMaxBytesEnum, UploadThresholdsMultipartChunkSizeEnum, UploadThresholdsMultipartConcurrencyDefaultEnum, } from '@giveitsmaller/contracts/openapi';
import { GislAbortError, GislApiError, GislAuthError, GislAuthRejectionError, GislBalanceExhaustedError, GislError, GislFeatureNotAvailableError, GislFeatureTierRestrictedError, GislMultipartPartCountError, GislMultipartPartError, GislMultipartSessionNotFoundError, GislMultipartSessionOwnershipError, GislMultipartSessionAuthRequiredError, GislTierRestrictedError, GislTimeoutError, GislProbePendingError, GislUploadCapExceededError, GislValidationError, GislWorkflowExpiredError, } from './errors.js';
// The `Retry-After` millisecond parser lives in the shared retry-metadata
// module (extracted to break the client ↔ errors circular import); re-imported
// here so the retry-loop timing stays byte-identical.
import { parseRetryAfterMs } from './retry-metadata.js';
import { parseSseStream } from './sse.js';
const DEFAULT_TIMEOUT_MS = 30_000;
// SDK-internal aliases derived from the contract-pinned UploadThresholds enums
// (compression_contracts/openapi schema `UploadThresholds`, ticket u0ar7Yye).
// `satisfies number` keeps the literal type so the drift guards below pin the
// expected value at compile time. Bumping any of these requires a contracts
// release that regenerates the corresponding *Enum, plus updating the literal
// in the matching `_AssertTrue<>` line.
const SINGLE_SHOT_MAX_BYTES = UploadThresholdsSingleShotMaxBytesEnum.NUMBER_10000000;
const MULTIPART_CHUNK_SIZE = UploadThresholdsMultipartChunkSizeEnum.NUMBER_16777216;
export const MULTIPART_CONCURRENCY_DEFAULT = UploadThresholdsMultipartConcurrencyDefaultEnum.NUMBER_4;
const DEFAULT_MULTIPART_MAX_ATTEMPTS = 3;
const DEFAULT_MULTIPART_RETRY_BASE_MS = 500;
// Fixed per contract (compression_contracts/openapi/api.yaml:134). The server
// uses the first chunk for MIME detection + throughput measurement and stores
// it as S3 multipart part 1. Must NOT be derived from multipartThreshold —
// that is the "use multipart above this size" routing threshold, a separate
// concept. Conflating them caused the /api/uploads/multipart/initiate 413.
// TODO(58nBQLWQ): replace with UploadThresholdsMultipartFirstChunkSizeEnum
// once contracts ticket promotes this to a typed const (v2.3.1 follow-up).
export const DEFAULT_MULTIPART_FIRST_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB
// The ~2 GB wall on a single Node file read is NOT a Buffer-size limit
// (modern 64-bit `buffer.constants.MAX_LENGTH` is ~8 PiB). It is libuv's
// hard-coded INT32_MAX (2 147 483 647) ceiling on one `uv_fs_read` — some
// platforms reject I/O larger than INT32_MAX bytes per call, so libuv caps
// every read at it (github.com/nodejs/node/issues/55864). The streaming
// upload path never approaches this (server chunk size is bounded to
// <=100 MiB and the first chunk is fixed 8 MiB), but `fileByteSource`
// asserts it per read so any future caller that requests an oversized range
// fails loudly here instead of getting a silently short read from libuv.
const LIBUV_MAX_SINGLE_READ_BYTES = 0x7fffffff; // INT32_MAX
// S3 hard limit: a multipart upload may have at most 10 000 parts. The
// server computes the part plan and returns `total_parts`; the SDK trusts
// that value (Model A) but guards the ceiling so an out-of-contract server
// response or a chunk-size regression surfaces as a typed error rather than
// a doomed run of presigned PUTs ending in a rejected /multipart/complete.
const S3_MAX_MULTIPART_PARTS = 10_000;
// Contract bound on `MultipartInitiateResponse.recommended_chunk_size`
// (compression_contracts/openapi api.yaml — `maximum: 104857600`). The
// minimum is `multipart_chunk_size` (== MULTIPART_CHUNK_SIZE, drift-guarded
// above). The generated TS `FromJSON` does NO runtime validation (unlike the
// strict PHP generated model, which rejects out-of-range values at
// deserialize), so the TS SDK must enforce this range itself — otherwise a
// malformed/hostile server `recommended_chunk_size` would pass the
// part-count guard and drive `fileByteSource` into an unbounded
// `Buffer.allocUnsafe(length)` (the exact memory-blowup class this SDK
// exists to prevent). codex review (high).
const RECOMMENDED_CHUNK_SIZE_MAX_BYTES = 104_857_600; // 100 MiB
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 300_000; // 5 min
// Anonymous-read capability header. An anonymous (null-owner) workflow create
// returns a one-time `cap` token (WorkflowCreateResponse.cap); the session-less
// caller passes it back on status/downloads/events reads via this header so the
// server can authorize the read. A wrong/missing cap on a null-owner workflow
// returns 404 (no existence oracle), per contracts ticket YQt88cq2.
const WORKFLOW_CAPABILITY_HEADER = 'X-Workflow-Capability';
// Build the capability header set for a workflow read. Empty when no token is
// supplied (authenticated reads — the session authorizes those).
function workflowCapabilityHeaders(capability) {
    return capability ? { [WORKFLOW_CAPABILITY_HEADER]: capability } : {};
}
// Statuses that waitForWorkflow() returns immediately on. Per ticket I24,
// `cancelled` and `expired` are terminal (a workflow cannot leave either
// state). `paused_insufficient_credits` is a soft-pause: not terminal, but
// polling blindly is the wrong behaviour because the workflow only resumes
// on caller action (top-up + resume). The SDK returns immediately so the
// caller can inspect `pausedDetail` and drive the resume flow.
const TERMINAL_STATUSES = new Set([
    WorkflowStatus.completed,
    WorkflowStatus.failed,
    WorkflowStatus.partially_failed,
    WorkflowStatus.cancelled,
    WorkflowStatus.expired,
    WorkflowStatus.paused_insufficient_credits,
]);
// Flatten a `Headers` object into a plain `Record<string,string>` for
// attaching to a thrown `GislApiError`. `Headers.forEach` yields LOWERCASED
// keys (HTTP header names are case-insensitive per RFC 9110) and collapses
// any multi-value header (e.g. `set-cookie`) into a single comma-joined
// value — the record is for content-language / vary / x-request-id reads,
// not cookies.
function headersToRecord(headers) {
    const r = {};
    headers.forEach((v, k) => {
        r[k] = v;
    });
    return r;
}
function isValidationDetails(value) {
    return (Array.isArray(value) &&
        value.length > 0 &&
        value.every((el) => typeof el === 'object' &&
            el !== null &&
            typeof el.message === 'string'));
}
// An abort may surface as DOMException (browser + modern Node), a plain Error
// subclass with name='AbortError', or (rarely) a plain object with that name
// on less conformant runtimes. Match any non-null thing exposing the name.
function isAbortError(err) {
    return (err !== null &&
        typeof err === 'object' &&
        err.name === 'AbortError');
}
// Retryable S3 PUT response statuses: 429 throttling, 503 slow-down, and any
// other 5xx (502/504 are common transients behind CloudFront/S3). 4xx other
// than 429 (403 signed-URL expiry, 400 SignatureDoesNotMatch, etc.) are
// configuration / authority issues — retrying just delays the real failure.
function isRetryableStatus(status) {
    return status === 429 || (status >= 500 && status <= 599);
}
// fetch surfaces network failures (DNS, TLS, TCP reset, mid-body disconnect)
// as TypeError. Abort surfaces as a DOMException with name='AbortError', not
// a TypeError, so a plain instanceof check is sufficient — abort is filtered
// before reaching here by the dedicated isAbortError guard in the catch.
function isRetryableNetworkError(err) {
    return err instanceof TypeError;
}
// Cancellable sleep for poll loops. Resolves after `ms`, or rejects with
// `GislAbortError` if `signal` aborts. Resolves immediately for ms <= 0.
function cancellableSleep(ms, signal) {
    if (signal?.aborted)
        return Promise.reject(new GislAbortError('waitForProbe aborted'));
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(new GislAbortError('waitForProbe aborted'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
// Full-jitter exponential backoff: delay = random(0, base * 2^attemptIndex).
// AWS SDK guidance for shared-throttling sources like S3 — keeps competing
// clients from synchronising their retries.
function fullJitterDelay(baseMs, attemptIndex) {
    if (baseMs <= 0)
        return 0;
    const ceiling = baseMs * Math.pow(2, attemptIndex);
    return Math.floor(Math.random() * ceiling);
}
// Cancel a Response body so undici (Node 18+ fetch) releases the underlying
// connection promptly instead of waiting for GC. We swallow any error: the
// retry loop is about to re-PUT the chunk; failing the cleanup must not
// shadow the real failure that triggered the retry.
async function drainResponseBody(response) {
    try {
        await response.body?.cancel();
    }
    catch {
        /* ignore */
    }
}
// Reject NaN/Infinity and floor at 1 attempt. A misconfigured 0/negative
// still attempts the PUT once (so callers see the underlying error rather
// than a silent zero-PUT no-op).
function sanitiseAttempts(value, fallback) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    return Math.max(1, Math.floor(value));
}
// Reject NaN/Infinity and clamp at 0. `0` is permitted so callers can opt out
// of backoff entirely (e.g. for fast-path tests); `Infinity` would otherwise
// stall the retry loop indefinitely on the very first backoff.
function sanitiseBaseMs(value, fallback) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    return Math.max(0, Math.floor(value));
}
// Reject NaN/Infinity and snap to fallback for any value below 1. Diverges
// from sanitiseAttempts (which floors at 1) because zero workers here is
// not a "fail-fast once" semantic — `Math.min(0, queue.length) = 0` at the
// worker fan-out site below produces zero S3 PUTs, so /multipart/complete
// is then called with an incomplete `parts` array (silent corruption).
// Garbage input almost certainly meant "use the default", not "send no parts".
function sanitiseConcurrency(value, fallback) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    const floored = Math.floor(value);
    return floored < 1 ? fallback : floored;
}
// Cancellable sleep. Resolves after `ms` ms, rejects with GislAbortError if
// the caller's signal aborts, or resolves early (without throwing) if the
// internal `wakeSignal` fires — that path lets a sibling worker's terminal
// failure short-circuit a peer's backoff sleep without producing a spurious
// abort error in the peer's own throw stack.
function sleepWithEitherSignal(ms, abortSignal, wakeSignal) {
    if (abortSignal?.aborted) {
        return Promise.reject(new GislAbortError('Multipart upload aborted'));
    }
    if (wakeSignal.aborted || ms <= 0)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            abortSignal?.removeEventListener('abort', onAbort);
            wakeSignal.removeEventListener('abort', onWake);
        };
        const onAbort = () => {
            clearTimeout(timer);
            cleanup();
            reject(new GislAbortError('Multipart upload aborted'));
        };
        const onWake = () => {
            clearTimeout(timer);
            cleanup();
            resolve();
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        wakeSignal.addEventListener('abort', onWake, { once: true });
    });
}
// Wire an optional external AbortSignal onto an internal per-request controller
// so either source trips the composed fetch. The `onExternalAbort` callback
// fires the moment the external signal aborts — callers use it to capture the
// temporal order of user-vs-timeout causes, so the tiebreak in request() does
// not rely on `signal.aborted` read at catch time (which flips true regardless
// of which cause actually fired first).
//
// Returns a teardown that removes the listener — must be called in a finally
// so long-lived user AbortControllers do not accumulate listeners across many
// uploads. Node 18+ compatible (no AbortSignal.any).
function bindAbortSignal(external, internal, onExternalAbort) {
    if (!external)
        return () => { };
    if (external.aborted) {
        onExternalAbort?.();
        internal.abort();
        return () => { };
    }
    const onAbort = () => {
        onExternalAbort?.();
        internal.abort();
    };
    external.addEventListener('abort', onAbort, { once: true });
    return () => external.removeEventListener('abort', onAbort);
}
// Blob/File input is already lazy: `Blob.slice()` is a zero-copy view and a
// `File` from a browser picker is disk-backed, so this branch never buffered
// the whole file. Left structurally identical to the pre-streaming-rewrite
// behaviour.
function blobByteSource(blob) {
    return {
        size: blob.size,
        // Pass `blob.type` as the 3rd arg: `Blob.slice()` defaults the slice's
        // content-type to '' otherwise, which would strip the MIME type off the
        // single-shot FormData part (the pre-streaming code appended the original
        // typed Blob directly). Parity fixtures pin this content-type.
        slice: (start, end) => Promise.resolve(blob.slice(start, end, blob.type)),
    };
}
// File-path input. The pre-rewrite code did `readFileSync(path)` →
// `new Blob([whole file])`, which (a) OOMs on multi-GB files and (b) cannot
// even be attempted above ~2 GB because a single libuv `uv_fs_read` is capped
// at INT32_MAX (see LIBUV_MAX_SINGLE_READ_BYTES). This source instead does a
// positioned (POSIX pread-semantics) read of ONLY the requested range, with a
// fresh fd per call so concurrent multipart workers never share a FileHandle
// (overlapping reads on one handle are unsafe per the Node fs contract) and
// the fd is always closed in `finally`.
//
// Divergence from the old Blob-from-readFileSync behaviour (deliberate, in
// scope only for streaming): the old path snapshotted the whole file at t0,
// so every part was point-in-time consistent. Streaming reads each part at
// the time it is uploaded, so a file truncated/rewritten mid-upload now
// yields parts from different instants. Truncation is caught by the
// short-read guard below; full point-in-time snapshotting would require
// resumable/staged upload and is out of scope (SDK-3, Wb6ebOMM).
function fileByteSource(path, size) {
    return {
        size,
        async slice(start, end) {
            const length = end - start;
            if (length <= 0)
                return new Blob([]);
            // Per-read tripwire for the libuv INT32_MAX ceiling. Unreachable on the
            // normal path (chunk size <=100 MiB) — exists so a future oversized
            // caller fails here loudly instead of getting a silent short read.
            if (length > LIBUV_MAX_SINGLE_READ_BYTES) {
                throw new GislError(`Refusing to read ${length} bytes in one operation: exceeds the ` +
                    `libuv single-read ceiling (${LIBUV_MAX_SINGLE_READ_BYTES}). ` +
                    'Reads must be chunked below INT32_MAX.');
            }
            const handle = await open(path, 'r');
            try {
                const buffer = Buffer.allocUnsafe(length);
                const { bytesRead } = await handle.read(buffer, 0, length, start);
                if (bytesRead !== length) {
                    // Short read = the file shrank/was truncated under us. Mirrors the
                    // PHP SDK's readChunk short-read guard (GislClient.php readChunk).
                    throw new GislError(`Short read on ${path}: expected ${length} bytes at offset ` +
                        `${start}, got ${bytesRead}. File changed during upload.`);
                }
                return new Blob([buffer]);
            }
            finally {
                await handle.close();
            }
        },
    };
}
export class GislClient {
    baseUrl;
    headers;
    timeoutMs;
    multipartThreshold;
    multipartConcurrency;
    multipartMaxAttempts;
    multipartRetryBaseMs;
    useSessionCookie;
    constructor(config) {
        this.baseUrl = config.baseUrl.replace(/\/+$/, '');
        this.timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;
        this.useSessionCookie = config.useSessionCookie ?? false;
        // Floor the threshold at the first-chunk size: the multipart initiate
        // must always carry an 8MB chunk, so routing a sub-8MB file into the
        // multipart path would violate the contract.
        this.multipartThreshold = Math.max(config.multipartThreshold ?? SINGLE_SHOT_MAX_BYTES, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE);
        this.multipartConcurrency = sanitiseConcurrency(config.multipartConcurrency, MULTIPART_CONCURRENCY_DEFAULT);
        // Sanitise: reject NaN/Infinity (the former would cause `attempt < NaN`
        // to be perpetually false, skipping every PUT; the latter would retry
        // unboundedly). Floor at 1 so a misconfigured 0/negative still attempts
        // once.
        this.multipartMaxAttempts = sanitiseAttempts(config.multipartMaxAttempts, DEFAULT_MULTIPART_MAX_ATTEMPTS);
        this.multipartRetryBaseMs = sanitiseBaseMs(config.multipartRetryBaseMs, DEFAULT_MULTIPART_RETRY_BASE_MS);
        this.headers = { ...config.headers };
        if (config.apiKey) {
            this.headers['Authorization'] = `Bearer ${config.apiKey}`;
        }
        // The dedicated `locale` option wins over any `Accept-Language` the caller
        // passed via `headers` (mirrors apiKey -> Authorization). Drop any caller
        // variant case-insensitively first so the request never carries two keys
        // (e.g. `accept-language` + `Accept-Language`) with undefined precedence.
        if (config.locale) {
            for (const key of Object.keys(this.headers)) {
                if (key.toLowerCase() === 'accept-language') {
                    delete this.headers[key];
                }
            }
            this.headers['Accept-Language'] = config.locale;
        }
    }
    // -----------------------------------------------------------------------
    // Internal HTTP
    // -----------------------------------------------------------------------
    async request(method, path, opts = {}) {
        // Fast-fail on a pre-aborted user signal before building the request.
        if (opts.signal?.aborted) {
            throw new GislAbortError(`Request to ${method} ${path} aborted`);
        }
        const url = `${this.baseUrl}${path}`;
        const headers = { ...this.headers, ...opts.headers };
        let body;
        if (opts.json !== false && opts.body && !(opts.body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(opts.body);
        }
        else {
            body = opts.body;
        }
        const controller = new AbortController();
        // Record the first cause that tripped the composed controller. Checking
        // `opts.signal.aborted` alone at catch time is not sound: if the timer
        // fires first and the user signal aborts microseconds later (before
        // `catch` runs), that flag is also true — but the true cause was the
        // timeout. Capturing which side fired first gives a deterministic
        // classification regardless of scheduling.
        let firstCause = null;
        const timer = setTimeout(() => {
            if (firstCause === null)
                firstCause = 'timeout';
            controller.abort();
        }, this.timeoutMs);
        const unbind = bindAbortSignal(opts.signal, controller, () => {
            if (firstCause === null)
                firstCause = 'user';
        });
        let response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body,
                signal: controller.signal,
                // `credentials: 'include'` on every request when the consumer opts
                // into cookie-based auth (Symfony session via /api/auth/login).
                // No-op in Node (fetch ignores the field there); mandatory for
                // cross-origin browser SPAs to send the session cookie.
                ...(this.useSessionCookie ? { credentials: 'include' } : {}),
            });
        }
        catch (err) {
            if (isAbortError(err)) {
                if (firstCause === 'user') {
                    throw new GislAbortError(`Request to ${method} ${path} aborted`);
                }
                throw new GislTimeoutError(`Request to ${method} ${path} timed out after ${this.timeoutMs}ms`);
            }
            throw err;
        }
        finally {
            clearTimeout(timer);
            unbind();
        }
        if (opts.rawResponse) {
            return response;
        }
        // 204 No Content — contracted success status for endpoints that return
        // no body (e.g. POST /api/contact). Short-circuit before handleResponse
        // so an empty body never trips the JSON parser.
        if (response.status === 204) {
            return undefined;
        }
        return this.handleResponse(response, path, opts.deserialize);
    }
    async handleResponse(response, path, deserialize) {
        // Surface the response headers (lowercased Record) and the resolved
        // `Content-Language` on every GislApiError thrown from this handler.
        const responseHeaders = headersToRecord(response.headers);
        const contentLanguage = response.headers.get('content-language') ?? undefined;
        const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
        const isJsonContent = contentType.includes('application/json') || contentType.includes('+json');
        if (!isJsonContent) {
            if (!response.ok) {
                throw new GislApiError(response.status, 'Non-JSON response', path, undefined, {
                    responseHeaders,
                    contentLanguage,
                });
            }
            return undefined;
        }
        // Wire-side fields are snake_case (raw response.json() — never run through
        // FromJSON helpers here). The structured-error subclasses receive a typed
        // payload built via the per-envelope FromJSON helper, which handles the
        // snake_case -> camelCase conversion for nested fields.
        let json;
        try {
            json = await response.json();
        }
        catch {
            throw new GislApiError(response.status, 'Invalid JSON response', path, undefined, {
                responseHeaders,
                contentLanguage,
            });
        }
        // Standard envelope: { success, data } or { success, error, details }
        if (!response.ok || json.success === false) {
            // Localisation triple per ticket I26 — surfaced on every typed error so
            // consumers can drive client-side i18n catalogs without unwrapping the
            // typed payload. Field names are wire snake_case here; the typed payload
            // (built via FromJSON below) carries camelCase copies.
            const i18n = {
                messageKey: json.message_key,
                locale: json.locale,
                messageParams: json.message_params,
                // The wire-stable machine code (SCREAMING_SNAKE `error`), surfaced as
                // `error.errorCode` on every dispatched error (PHP parity). Threaded via
                // this single options object → base GislApiError, GislValidationError,
                // and every structured subclass (passed through as `extra`).
                errorCode: typeof json.error === 'string' ? json.error : undefined,
                responseHeaders,
                contentLanguage,
            };
            // Human-readable text comes from `message` (the I26 localised field).
            // `error` is the stable, never-localised SCREAMING_SNAKE machine code —
            // NOT display text. Surfacing `error` as the thrown error's `.message`
            // regressed consumers that render the human string (x9Lbf6uy). Fall back
            // to `error` when `message` is absent (deployed contract guarantees
            // `message` on conforming error envelopes). Machine dispatch keys off
            // `error_type` (below), unchanged.
            const status = response.status;
            const errorMessage = json.message ?? json.error ?? 'Unknown error';
            // Validation-details branch first — preserve existing shape so callers
            // matching on `instanceof GislValidationError` keep working.
            if (isValidationDetails(json.details)) {
                throw new GislValidationError(response.status, errorMessage, json.details, path, i18n);
            }
            // Dispatch by (status, error_type) onto the structured envelope shapes
            // emitted by the v2 contracts. Each branch builds the typed payload via
            // the generated FromJSON helper so consumers reading e.g.
            // `error.payload.errorType` see camelCase fields rather than the raw
            // wire snake_case.
            //
            // Defense-in-depth: if a malformed wire envelope causes the FromJSON
            // helper to throw or coerce a required field to a sentinel value
            // (e.g. `expired_at` missing -> `new Date(undefined)` => Invalid Date),
            // fall through to the base `GislApiError` rather than handing the
            // caller silently-corrupted typed metadata.
            const errorType = json.error_type;
            // Build the typed payload via FromJSON, then validate that all
            // required typed fields are well-formed. FromJSON does not throw on
            // missing required fields — for example `workflow_expired` without
            // `expired_at` produces `new Date(undefined)` => Invalid Date with
            // `getTime() === NaN`. Without an explicit validity check the error
            // would surface a silently-corrupted typed payload instead of falling
            // through to the generic base class.
            const tryThrowStructured = (construct, ErrorClass, validate) => {
                let payload;
                try {
                    payload = construct(json);
                }
                catch {
                    return undefined;
                }
                if (validate && !validate(payload)) {
                    return undefined;
                }
                throw new ErrorClass(status, errorMessage, payload, path, i18n);
            };
            const isValidDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());
            if (status === 401 || status === 403) {
                if (errorType && this.isAuthErrorType(errorType)) {
                    tryThrowStructured(AuthErrorResponseFromJSON, GislAuthError, (p) => typeof p.errorType === 'string');
                }
            }
            const isInEnum = (value, members) => typeof value === 'string' && Object.values(members).includes(value);
            const isFeatureViolation = (v) => typeof v === 'object' && v !== null
                && typeof v.feature === 'string';
            if (status === 402 && errorType === 'balance_exhausted') {
                tryThrowStructured(BalanceExhaustedResponseFromJSON, GislBalanceExhaustedError, (p) => isInEnum(p.requiredAction, BalanceExhaustedResponseRequiredActionEnum));
            }
            if (status === 403 && errorType === 'tier_restriction') {
                tryThrowStructured(TierRestrictionResponseFromJSON, GislTierRestrictedError, (p) => isInEnum(p.restrictionKind, TierRestrictionKind)
                    && isInEnum(p.currentTier, UserTier));
            }
            if (status === 403 && errorType === 'feature_tier_restricted') {
                tryThrowStructured(FeatureTierRestrictedResponseFromJSON, GislFeatureTierRestrictedError, (p) => Array.isArray(p.violations) && p.violations.every(isFeatureViolation));
            }
            if (status === 422 && errorType === 'feature_not_available') {
                tryThrowStructured(FeatureNotAvailableResponseFromJSON, GislFeatureNotAvailableError, (p) => Array.isArray(p.violations) && p.violations.every(isFeatureViolation));
            }
            if (status === 422 && errorType === 'workflow_expired') {
                tryThrowStructured(WorkflowExpiredResponseFromJSON, GislWorkflowExpiredError, (p) => isValidDate(p.expiredAt));
            }
            // Probe-pending 422 on POST /api/workflows (per contracts av1J0rEF).
            // Recovery: caller polls /api/uploads/{id}/probe until terminal, then
            // retries the workflow-create. `payload.jobRef` names which job.
            //
            // Defensive against v2.15.3 generator-bug: the openapi-generator-emitted
            // `instanceOfProbePendingResponse` checks camelCase fields against the
            // raw snake_case wire — fails dispatch when used at the CreateWorkflow
            // 422 union top-level. We branch on the already-parsed `error_type`
            // here (the SDK-side snake_case envelope read at line 659) and
            // validate the payload shape directly on the raw JSON before
            // ProbePendingResponseFromJSON converts snake_case → camelCase.
            // Robust to BOTH the current v2.15.3 broken dispatch AND any future
            // v2.15.4 fix that lands a discriminator.
            if (status === 422 && errorType === 'probe_pending') {
                tryThrowStructured(ProbePendingResponseFromJSON, GislProbePendingError, (p) => typeof p.jobRef === 'string' && p.jobRef.length > 0);
            }
            // Upload cap errors. `GislUploadCapExceededError` takes an extra `kind`
            // arg so it cannot use `tryThrowStructured` (whose ErrorClass signature
            // is fixed) — this local helper applies the SAME defense-in-depth
            // discipline: construct via FromJSON, validate required typed fields,
            // fall through to the generic `GislApiError` on any malformed envelope.
            const tryThrowCap = (construct, kind, validate) => {
                let payload;
                try {
                    payload = construct(json);
                }
                catch {
                    return undefined;
                }
                if (!validate(payload)) {
                    return undefined;
                }
                throw new GislUploadCapExceededError(status, errorMessage, kind, payload, path, i18n);
            };
            if (status === 422 && errorType === 'upload_size_exceeds_tier') {
                tryThrowCap(UploadSizeExceedsTierResponseFromJSON, 'size_tier', (p) => isInEnum(p.currentTier, UserTier) &&
                    typeof p.maxSizeBytes === 'number');
            }
            if (status === 422 && errorType === 'upload_duration_exceeds_tier') {
                tryThrowCap(UploadDurationExceedsTierResponseFromJSON, 'duration_tier', (p) => isInEnum(p.currentTier, UserTier) &&
                    typeof p.maxDurationSeconds === 'number');
            }
            // 413 = the absolute across-tier cap. The contract models 413 as a
            // plain `ErrorEnvelope` (no `error_type` discriminator, no typed
            // payload — api.yaml), so dispatch purely on status with no FromJSON
            // and an undefined payload (the `absolute_413` kind tells the caller
            // there is intentionally no structured envelope to read).
            if (status === 413) {
                throw new GislUploadCapExceededError(status, errorMessage, 'absolute_413', undefined, path, i18n);
            }
            // SDK-3 (Wb6ebOMM) resume-support endpoint error codes. API-2 / PR
            // #283 specced these as plain `ErrorEnvelope` envelopes with the
            // discriminating string on `error_type`. No typed payload to build —
            // dispatch on the (status, error_type) tuple. The HxUmVr3Y contract
            // regen will produce typed responses for these; today the 3 typed
            // subclasses carry only the localisation triple + raw envelope.
            if (status === 404 && errorType === 'MULTIPART_SESSION_NOT_FOUND') {
                throw new GislMultipartSessionNotFoundError(status, errorMessage, path, i18n);
            }
            if (status === 403 && errorType === 'MULTIPART_SESSION_OWNERSHIP') {
                throw new GislMultipartSessionOwnershipError(status, errorMessage, path, i18n);
            }
            if (status === 403 && errorType === 'MULTIPART_SESSION_AUTH_REQUIRED') {
                throw new GislMultipartSessionAuthRequiredError(status, errorMessage, path, i18n);
            }
            // 422 `FILE_TOO_LARGE_FOR_MULTIPART` — pre-S3 capacity reject on the
            // resume-support presign endpoint (more parts than the manifest can
            // ever accept). No typed payload today (the contract carries no
            // structured response for this code); `cap_v2_multipart` discriminant
            // is documented on `GislUploadCapKind`.
            if (status === 422 && errorType === 'FILE_TOO_LARGE_FOR_MULTIPART') {
                throw new GislUploadCapExceededError(status, errorMessage, 'cap_v2_multipart', undefined, path, i18n);
            }
            // 422 auth-side-effect domain rejection (per contracts ADR-0019).
            // Flat AuthRejectionEnvelope — NO `details[]` — on register /
            // verify-email / api-keys (`error_type: unprocessable_entity`) and
            // profile PATCH email-unchanged (`error_type: email_same`). The
            // `validation_error` branch of the same auth-422 `oneOf` carries
            // `details[]` and is already routed to GislValidationError by the
            // shape-based branch above. Mirrors
            // `packages/php/src/GislClient.php` GislAuthRejectionError branch.
            if (status === 422 &&
                isInEnum(errorType, AuthRejectionEnvelopeErrorTypeEnum)) {
                tryThrowStructured(AuthRejectionEnvelopeFromJSON, GislAuthRejectionError, (p) => isInEnum(p.errorType, AuthRejectionEnvelopeErrorTypeEnum));
            }
            throw new GislApiError(status, errorMessage, path, json.details, { ...i18n, payload: json });
        }
        const data = json.data ?? json;
        return deserialize ? deserialize(data) : data;
    }
    // Membership check for the AuthErrorType discriminator. Reads the generated
    // enum object directly so a future contract addition lands here without a
    // hand-edit. The bundle cost is one tiny `as const` literal map (8 entries).
    isAuthErrorType(value) {
        return Object.values(AuthErrorType).includes(value);
    }
    // -----------------------------------------------------------------------
    // Upload
    // -----------------------------------------------------------------------
    /**
     * Upload a file. Automatically uses multipart upload for files exceeding
     * the configured threshold (default 10 MB).
     *
     * @param file  File path (string) or a Blob/File instance.
     * @param options  Upload options including progress callback.
     */
    async uploadFile(file, options) {
        // Pre-abort check: bail before touching the filesystem when the caller
        // has already cancelled.
        if (options?.signal?.aborted) {
            throw new GislAbortError('Upload aborted before start');
        }
        let source;
        let fileName;
        if (typeof file === 'string') {
            // `stat` for the size only — the bytes are NEVER read up front. The old
            // path did `readFileSync(file)` which OOMs on multi-GB files and is
            // impossible above the libuv INT32_MAX single-read ceiling regardless
            // of available memory (see fileByteSource / LIBUV_MAX_SINGLE_READ_BYTES).
            const stats = await stat(file);
            fileName = basename(file);
            source = fileByteSource(file, stats.size);
        }
        else {
            fileName = file.name ?? 'upload';
            source = blobByteSource(file);
        }
        if (typeof options?.resumeUploadId === 'string' && options.resumeUploadId !== '') {
            // SDK-3 (Wb6ebOMM): resume path takes the durable session's
            // `recommended_chunk_size` from the /status envelope rather than
            // the initiate envelope (initiate is skipped). Below the multipart
            // threshold a resume is still meaningful — the original session was
            // started as multipart, so a sub-threshold file CAN'T be a "resume
            // target" in practice. Guard explicitly so a confused caller gets a
            // clear error rather than a 404 on /status.
            if (source.size <= this.multipartThreshold) {
                throw new GislError('uploadFile: resumeUploadId set but file size is at-or-below the multipart ' +
                    `threshold (${this.multipartThreshold} bytes); resume targets must be multipart sessions.`);
            }
            return this.multipartResume(source, fileName, source.size, options.resumeUploadId, options);
        }
        if (source.size > this.multipartThreshold) {
            return this.multipartUpload(source, fileName, source.size, options);
        }
        return this.singleUpload(source, fileName, options);
    }
    async singleUpload(source, fileName, options) {
        const form = new FormData();
        // Single-shot is gated to <= single_shot_max_bytes (10 MB) by the router
        // above, so this one bounded read is trivially under the libuv ceiling
        // and a non-issue for memory. `slice` returns a Blob (the file-path
        // source wraps the bounded Buffer) so FormData.append is unchanged —
        // multipart never wraps a whole-file Blob, only this <=10 MB single-shot
        // path ever holds a full payload Blob.
        const body = await source.slice(0, source.size);
        form.append('file', body, fileName);
        return this.request('POST', '/api/uploads', {
            body: form,
            json: false,
            deserialize: UploadResponseFromJSON,
            signal: options?.signal,
        });
    }
    /**
     * Direct-to-S3 multipart upload for files above the threshold.
     *
     * The /multipart/complete response (MultipartCompleteResponse) only carries
     * { upload_id, status }. The server's upload_id is the same UUID callers
     * pass as file_id to POST /api/workflows — so fileId is synthesised from
     * upload_id and a full UploadResponse is returned to keep the public
     * uploadFile() API uniform across single and multipart paths. The mimeType
     * comes from the initiate response's first-chunk detection; for authoritative
     * post-upload metadata callers should use getMetadata(fileId).
     */
    async multipartUpload(source, fileName, totalSize, options) {
        // Step 1: Initiate with first chunk
        const firstChunkSize = Math.min(totalSize, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE);
        const firstChunk = await source.slice(0, firstChunkSize);
        const initiateForm = new FormData();
        initiateForm.append('file', firstChunk, fileName);
        initiateForm.append('filename', fileName);
        initiateForm.append('total_size', totalSize.toString());
        if (options?.metadataHint !== undefined) {
            // Wire format: a single FormData field carrying the JSON-stringified
            // hint object. Single-shot uploads do not accept this field — see
            // singleUpload() which silently ignores `options.metadataHint`.
            // Route through the generated ToJSON helper so the wire form is the
            // contract-pinned snake_case shape (`duration_seconds`, `width`,
            // `height`). Stringify-ing the camelCase TS object directly would
            // emit `durationSeconds` and the server would silently drop it,
            // defeating the hint's primary use (long-form pre-classification when
            // the first-chunk probe lacks container metadata).
            initiateForm.append('metadata_hint', JSON.stringify(MultipartInitiateRequestMetadataHintToJSON(options.metadataHint)));
        }
        const initResponse = await this.request('POST', '/api/uploads/multipart/initiate', {
            body: initiateForm,
            json: false,
            deserialize: MultipartInitiateResponseFromJSON,
            signal: options?.signal,
        });
        let uploadedBytes = firstChunkSize;
        options?.onProgress?.(uploadedBytes, totalSize);
        // Step 2: Upload remaining chunks to S3 presigned URLs
        const etags = [];
        const presignedUrls = initResponse.presignedUrls;
        const chunkSize = initResponse.recommendedChunkSize;
        // MultipartInitiateResponseFromJSON does NO runtime validation (unlike
        // the strict PHP generated model, which rejects these at deserialize —
        // the documented lax-TS-vs-strict-PHP divergence). The TS SDK must
        // therefore enforce, before any chunk read/PUT, what PHP gets for free
        // from its generated model + its explicit pre-loop guards (codex review):
        //
        // (a) uploadId must be a non-empty string. `FromJSON` assigns
        //     `json['upload_id']` directly, so a malformed initiate could
        //     otherwise produce a typed GislMultipartPartError whose `uploadId`
        //     is `undefined` and synthesise a bogus UploadResponse.fileId —
        //     mirrors the PHP pre-loop `is_string && !== ''` guard.
        if (typeof initResponse.uploadId !== 'string' ||
            initResponse.uploadId === '') {
            throw new GislError('Multipart initiate response missing or empty upload_id.');
        }
        // (b) recommendedChunkSize must be a finite number INSIDE the contract
        //     range [MULTIPART_CHUNK_SIZE, RECOMMENDED_CHUNK_SIZE_MAX_BYTES]. The
        //     old `>= 1` check let a malformed/hostile huge value pass the
        //     part-count guard and drive `fileByteSource` into an unbounded
        //     `Buffer.allocUnsafe(length)` — the memory-blowup class this SDK
        //     exists to prevent. PHP's strict generated model already rejects
        //     out-of-range values at deserialize; this is the TS equivalent.
        if (typeof chunkSize !== 'number' ||
            !Number.isInteger(chunkSize) ||
            chunkSize < MULTIPART_CHUNK_SIZE ||
            chunkSize > RECOMMENDED_CHUNK_SIZE_MAX_BYTES) {
            // `Number.isInteger` also rejects NaN/Infinity and a fractional
            // `recommended_chunk_size` (e.g. 5242880.5) that would otherwise
            // reach `Buffer.allocUnsafe(fractional)` and fail later as a
            // misleading part-read error (codex review).
            throw new GislError('Multipart initiate response recommendedChunkSize is missing or ' +
                `outside the contract range [${MULTIPART_CHUNK_SIZE}, ` +
                `${RECOMMENDED_CHUNK_SIZE_MAX_BYTES}]: got ${String(chunkSize)}.`);
        }
        // S3 <=10 000-part ceiling guard (Model A). The server computes and
        // returns `totalParts`; we trust it (consistent with how the SDK already
        // trusts `recommendedChunkSize`/`presignedUrls` from the same envelope)
        // but assert the ceiling, cross-checked against a client-side recompute
        // from the same `chunkSize`. This necessarily fires AFTER the initiate
        // round-trip + 8 MiB first-chunk upload — `totalParts` and `chunkSize`
        // only exist on the initiate response, so a pure pre-flight check is
        // impossible under Model A (this is the card-mandated trade-off).
        const remainingBytes = Math.max(0, totalSize - firstChunkSize);
        const computedParts = 1 + Math.ceil(remainingBytes / chunkSize);
        const serverParts = initResponse.totalParts;
        // `FromJSON` passes `total_parts` through unvalidated. Reject a
        // missing/non-integer value here so the ≤10k guard's
        // `Math.max(serverParts, computedParts)` cannot surface `NaN` in the
        // GislMultipartPartCountError (codex review). Mirrors the uploadId /
        // chunkSize guards above (the lax-TS-vs-strict-PHP-model divergence).
        if (typeof serverParts !== 'number' ||
            !Number.isInteger(serverParts) ||
            serverParts < 1) {
            throw new GislError('Multipart initiate response missing or invalid total_parts: ' +
                `got ${String(serverParts)}.`);
        }
        if (serverParts > S3_MAX_MULTIPART_PARTS ||
            computedParts > S3_MAX_MULTIPART_PARTS) {
            throw new GislMultipartPartCountError(`Upload requires ${Math.max(serverParts, computedParts)} parts, ` +
                `exceeding the S3 ${S3_MAX_MULTIPART_PARTS}-part multipart limit ` +
                `(server reported ${serverParts}, client computed ${computedParts} ` +
                `at ${chunkSize}-byte chunks). A larger chunk size is required ` +
                'server-side to upload a file this large.', Math.max(serverParts, computedParts), S3_MAX_MULTIPART_PARTS);
        }
        // Plan-consistency guard (codex review). The ≤10k ceiling above only
        // bounds the count; it does NOT catch an initiate plan that is internally
        // inconsistent BELOW the cap. Under Model A a contract-compliant server
        // computes `total_parts` from the same `recommended_chunk_size` it
        // returns, and emits exactly one presigned URL per remaining part (part 1
        // is the initiate first chunk). If `total_parts`, the client recompute,
        // and `presigned_urls.length` disagree, proceeding would PUT the wrong
        // number of byte ranges (or wrong offsets) and only fail opaquely at
        // /multipart/complete. Fail fast here with the discrepancy instead.
        if (!Number.isFinite(serverParts) ||
            serverParts !== computedParts ||
            presignedUrls.length !== computedParts - 1) {
            throw new GislError('Multipart initiate plan is internally inconsistent: server ' +
                `total_parts=${serverParts}, client computed ${computedParts} ` +
                `from ${chunkSize}-byte chunks, presigned_urls.length=` +
                `${presignedUrls.length} (expected ${computedParts - 1}). ` +
                'Refusing to upload a mismatched part plan.');
        }
        // Internal abort signal that workers use to short-circuit each others'
        // backoff sleeps. When any worker hits a terminal failure it aborts this
        // controller, which races the caller's signal inside sleepWithSignal so
        // sleeping siblings stop waiting for their timer to expire.
        const failureController = new AbortController();
        // Single PUT attempt. Returns a structured outcome instead of throwing
        // for retryable/non-retryable distinctions, so the caller can decide
        // whether to loop without conflating user-callback errors with
        // network-layer retries (codex review).
        const attemptPut = async (part, chunk, contentLength) => {
            let s3Response;
            try {
                s3Response = await fetch(part.url, {
                    method: 'PUT',
                    body: chunk,
                    headers: { 'Content-Length': contentLength.toString() },
                    signal: options?.signal,
                });
            }
            catch (err) {
                if (isAbortError(err) && options?.signal?.aborted) {
                    return {
                        kind: 'fatal',
                        err: new GislAbortError(`S3 part ${part.partNumber} upload aborted`),
                    };
                }
                if (isRetryableNetworkError(err)) {
                    return { kind: 'retryable', lastErr: err };
                }
                return { kind: 'fatal', err };
            }
            if (s3Response.ok) {
                const etag = s3Response.headers.get('etag');
                if (!etag) {
                    // Drain the body even though we're failing fast — keeps the
                    // connection released eagerly.
                    await drainResponseBody(s3Response);
                    return {
                        kind: 'fatal',
                        err: new GislError(`S3 response missing ETag for part ${part.partNumber}`),
                    };
                }
                return { kind: 'ok', etag };
            }
            // Non-OK: drain the body in BOTH branches before deciding. Undici
            // holds the connection open until the body is consumed regardless of
            // whether we retry.
            await drainResponseBody(s3Response);
            if (!isRetryableStatus(s3Response.status)) {
                return {
                    kind: 'fatal',
                    err: new GislError(`S3 chunk upload failed for part ${part.partNumber}: ${s3Response.status}`),
                };
            }
            return {
                kind: 'retryable',
                lastErr: new GislError(`S3 chunk upload failed for part ${part.partNumber}: ${s3Response.status}`),
            };
        };
        const uploadChunk = async (index) => {
            const part = presignedUrls[index];
            const start = firstChunkSize + index * chunkSize;
            const end = Math.min(start + chunkSize, totalSize);
            // Read this part's bytes ONCE here, then reuse the captured chunk
            // across every retry attempt below — so a retry never re-reads the
            // file and the re-PUT is byte-identical (S3 parts are idempotent by
            // partNumber; a re-PUT overwrites, no duplicate-data risk).
            //
            // Live-file caveat (streaming divergence from the old
            // readFileSync→Blob path): the old code snapshotted the whole file at
            // t0 so every part was point-in-time consistent. Streaming reads each
            // part at the instant it is first uploaded, so a file mutated
            // mid-upload yields parts from different instants. Truncation is
            // caught by fileByteSource's short-read guard; full point-in-time
            // snapshotting is resumable/staged-upload territory (SDK-3, Wb6ebOMM).
            // Surface a read failure for THIS part as the typed
            // GislMultipartPartError (with partNumber + uploadId), consistent with
            // the PUT-failure path below — a bare GislError from fileByteSource
            // (short read / libuv ceiling) would otherwise lose the per-part
            // context (codex review). An abort must stay GislAbortError.
            let chunk;
            try {
                chunk = await source.slice(start, end);
            }
            catch (err) {
                if (err instanceof GislAbortError)
                    throw err;
                throw new GislMultipartPartError(`Failed to read bytes for part ${part.partNumber}: ` +
                    (err instanceof Error ? err.message : String(err)), part.partNumber, initResponse.uploadId);
            }
            const contentLength = end - start;
            let lastErr = null;
            for (let attempt = 0; attempt < this.multipartMaxAttempts; attempt++) {
                if (options?.signal?.aborted) {
                    throw new GislAbortError(`S3 part ${part.partNumber} upload aborted`);
                }
                if (failureController.signal.aborted) {
                    // Sibling worker hit a terminal failure: bail before dispatching a
                    // wasted PUT. The thrown error is swallowed by the outer worker
                    // loop — Promise.all has already settled with the first failure.
                    throw new GislError(`S3 part ${part.partNumber} upload abandoned after sibling worker failure`);
                }
                const outcome = await attemptPut(part, chunk, contentLength);
                if (outcome.kind === 'ok') {
                    // Apply progress side effects OUTSIDE the retry-scoped path so a
                    // user-callback throw does not trigger a duplicate PUT (codex
                    // review: retrying after a successful PUT would double-record the
                    // ETag and re-upload an already accepted part).
                    etags.push({ partNumber: part.partNumber, etag: outcome.etag });
                    uploadedBytes += contentLength;
                    options?.onProgress?.(uploadedBytes, totalSize);
                    return;
                }
                if (outcome.kind === 'fatal') {
                    throw outcome.err;
                }
                lastErr = outcome.lastErr;
                if (attempt + 1 >= this.multipartMaxAttempts)
                    break;
                const delay = fullJitterDelay(this.multipartRetryBaseMs, attempt);
                // Race the caller's signal AND the sibling-failure signal so a
                // worker that fails terminally wakes its sleeping peers instead of
                // forcing them to wait out their backoff timer.
                await sleepWithEitherSignal(delay, options?.signal, failureController.signal);
            }
            throw new GislMultipartPartError(`S3 chunk upload failed for part ${part.partNumber} after ${this.multipartMaxAttempts} attempts: ` +
                (lastErr instanceof Error ? lastErr.message : String(lastErr)), part.partNumber, initResponse.uploadId);
        };
        // Upload with concurrency limit. Workers check the signal before pulling
        // the next queue item so a mid-upload abort drains fast without
        // dispatching new chunks. Chunks already in-flight are cancelled via the
        // composed signal passed to fetch above; sleeping siblings are woken via
        // the failureController set below.
        const queue = [...presignedUrls.keys()];
        const workers = Array.from({ length: Math.min(this.multipartConcurrency, queue.length) }, async () => {
            while (queue.length > 0 && !failureController.signal.aborted) {
                if (options?.signal?.aborted) {
                    throw new GislAbortError('Multipart upload aborted');
                }
                const index = queue.shift();
                try {
                    await uploadChunk(index);
                }
                catch (err) {
                    // Wake any sibling currently in a backoff sleep, and prevent
                    // siblings from picking up further queue items.
                    failureController.abort();
                    throw err;
                }
            }
        });
        await Promise.all(workers);
        // Step 3: Complete multipart upload.
        // Build a typed MultipartCompleteRequest and serialise via the generated
        // ToJSON helper — tsc now catches any field-name drift between the SDK
        // and the OpenAPI spec (see contract-drift-fields.test.ts describe 'c').
        etags.sort((a, b) => a.partNumber - b.partNumber);
        const completeRequest = {
            uploadId: initResponse.uploadId,
            parts: etags,
        };
        // MultipartCompleteRequestToJSON's declared return type is the camelCase
        // `MultipartCompleteRequest` interface, but at runtime it returns the
        // snake_case wire object — an openapi-generator v7 quirk. The drift gate
        // for field names lives at `completeRequest: MultipartCompleteRequest`
        // above; the local wire type + runtime sanity check below guard against
        // the remaining hypothetical: a future generator version emitting a
        // different shape without the declared type catching it.
        const wireCompleteBody = MultipartCompleteRequestToJSON(completeRequest);
        if (typeof wireCompleteBody?.upload_id !== 'string' ||
            !Array.isArray(wireCompleteBody?.parts)) {
            throw new GislError('MultipartCompleteRequestToJSON returned an unexpected shape — generator output may have changed.');
        }
        const completeResp = await this.request('POST', '/api/uploads/multipart/complete', {
            body: wireCompleteBody,
            deserialize: MultipartCompleteResponseFromJSON,
            signal: options?.signal,
        });
        // Defensive: the status enum currently has only 'completed', but guard
        // against future expansion so an unexpected terminal state doesn't pass
        // as a successful upload.
        if (completeResp.status !== 'completed') {
            throw new GislError(`Multipart upload completed with unexpected status: ${completeResp.status}`);
        }
        return {
            fileId: completeResp.uploadId,
            originalName: fileName,
            mimeType: initResponse.mimeType,
            // `totalSize` (from fs.stat / Blob.size) — the streaming path no longer
            // holds a whole-file Blob to read `.size` off.
            sizeBytes: totalSize,
            // Preserved from the initiate response: v2 contract makes
            // `constraintsApplied` a REQUIRED field on UploadResponse, and the
            // multipart/complete endpoint does not re-emit it. The first-chunk probe
            // result on the initiate envelope is the authoritative source.
            constraintsApplied: initResponse.constraintsApplied,
        };
    }
    /**
     * SDK-3 (Wb6ebOMM): resume an in-progress multipart upload.
     *
     * Skips `/multipart/initiate` entirely (the original initiate happened in a
     * prior process). Walks `/status` for the authoritative list of recorded
     * parts, re-presigns the missing ones in batches of <=100, PUTs only those,
     * and finalises with `/complete`. Caller's `source` MUST be byte-identical
     * to the originally-uploaded file at the same offsets (parts whose etags
     * don't match server state will fail `/complete`).
     *
     * Re-runs the same `uploadId` / `chunkSize` / `totalParts` / plan-consistency
     * guards as the fresh-upload path (`multipartUpload`), using the /status
     * envelope as the equivalent of the initiate envelope. Reuses the same
     * `failureController` sibling-wake + `drainResponseBody` cleanup discipline
     * as the fresh-upload PUT loop. `onProgress` fires on entry seeded from
     * (uploadedPartNumbers.length * chunkSize) and again after every successful
     * PUT. `onCheckpoint` fires OUTSIDE the retry-scoped path after every
     * successful PUT — a callback-throw must not trigger a duplicate PUT.
     *
     * TODO(HxUmVr3Y): replace inline hand-coded request body marshalling on regen.
     */
    async multipartResume(source, fileName, totalSize, resumeUploadId, options) {
        // Step 1: Walk /status for the authoritative session state.
        const status = await this.walkUploadStatus(resumeUploadId, {
            signal: options?.signal,
        });
        // Validate the /status envelope shape, mirroring the fresh-upload
        // post-initiate guards (`multipartUpload` lines around the
        // total_parts / recommendedChunkSize / uploadId validation block).
        if (typeof status.uploadId !== 'string' ||
            status.uploadId === '' ||
            status.uploadId !== resumeUploadId) {
            throw new GislError('multipartResume: /status response uploadId does not match resumeUploadId.');
        }
        const chunkSize = status.recommendedChunkSize;
        if (typeof chunkSize !== 'number' ||
            !Number.isInteger(chunkSize) ||
            chunkSize < MULTIPART_CHUNK_SIZE ||
            chunkSize > RECOMMENDED_CHUNK_SIZE_MAX_BYTES) {
            throw new GislError('multipartResume: /status recommendedChunkSize missing or outside the contract ' +
                `range [${MULTIPART_CHUNK_SIZE}, ${RECOMMENDED_CHUNK_SIZE_MAX_BYTES}]: got ${String(chunkSize)}.`);
        }
        if (typeof status.totalParts !== 'number' ||
            !Number.isInteger(status.totalParts) ||
            status.totalParts < 1) {
            throw new GislError(`multipartResume: /status totalParts missing or invalid: got ${String(status.totalParts)}.`);
        }
        if (status.totalParts > S3_MAX_MULTIPART_PARTS) {
            throw new GislMultipartPartCountError(`multipartResume: /status totalParts=${status.totalParts} exceeds the S3 ` +
                `${S3_MAX_MULTIPART_PARTS}-part multipart limit.`, status.totalParts, S3_MAX_MULTIPART_PARTS);
        }
        // Sanity-check the caller's byte source against the server's recorded
        // plan. Mirrors the fresh-upload chunk-plan: part 1 = firstChunkSize
        // (8 MiB), parts 2..totalParts each consume chunkSize bytes (last part
        // may be a short tail). Reject a wrong-file resume here — /complete
        // would otherwise fail on etag mismatch.
        const firstChunkSize = Math.min(totalSize, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE);
        const expectedMinBytes = firstChunkSize + Math.max(0, status.totalParts - 2) * chunkSize + (status.totalParts > 1 ? 1 : 0);
        const expectedMaxBytes = firstChunkSize + Math.max(0, status.totalParts - 1) * chunkSize;
        if (totalSize < expectedMinBytes || totalSize > expectedMaxBytes) {
            throw new GislError(`multipartResume: caller file size (${totalSize}) does not match the resumed ` +
                `session's recorded plan (totalParts=${status.totalParts}, chunkSize=${chunkSize}, ` +
                `expected ${expectedMinBytes}-${expectedMaxBytes} bytes). Wrong file for this uploadId?`);
        }
        // Step 2: Compute missing parts. Server records `uploadedParts` as the
        // authoritative set; everything in [1, totalParts] not in that set is
        // still-to-upload. Part 1 was uploaded inline at initiate — if it is
        // missing from /status the session is unrecoverable (the server rejects
        // re-presigning part 1 to preserve the recorded etag for /complete).
        const uploaded = new Map();
        for (const p of status.uploadedParts) {
            uploaded.set(p.partNumber, p);
        }
        if (!uploaded.has(1)) {
            throw new GislError('multipartResume: part 1 (initiate first chunk) is missing from /status. ' +
                'Part 1 is sealed at initiate and cannot be re-presigned; this session is unrecoverable. ' +
                'Start a fresh upload (call uploadFile without resumeUploadId).');
        }
        const missingParts = [];
        for (let n = 2; n <= status.totalParts; n++) {
            if (!uploaded.has(n))
                missingParts.push(n);
        }
        // Seed uploadedBytes from already-uploaded parts so onProgress reflects
        // the true resumption point. Server reports authoritative part sizes
        // via `sizeBytes`; sum those rather than guessing chunkSize * count
        // (the last part may be a short tail).
        let uploadedBytes = 0;
        for (const p of status.uploadedParts) {
            uploadedBytes += p.sizeBytes;
        }
        options?.onProgress?.(uploadedBytes, totalSize);
        const fireCheckpoint = (extraPartNumber) => {
            const all = [...uploaded.keys()];
            if (extraPartNumber !== undefined)
                all.push(extraPartNumber);
            all.sort((a, b) => a - b);
            const state = {
                uploadId: status.uploadId,
                totalParts: status.totalParts,
                uploadedPartNumbers: all,
                manifestExpiresAt: status.manifestExpiresAt,
            };
            // Callback fires OUTSIDE retry-scope. A throw here propagates and
            // fails the upload but cannot trigger a duplicate PUT.
            options?.onCheckpoint?.(state);
        };
        // Fire an entry checkpoint so callers can persist the resumed state
        // even before any new PUT lands. Useful when the missing-parts list is
        // empty (everything already uploaded except /complete) — see below.
        fireCheckpoint();
        // Short-circuit: every part is already uploaded. Skip presign + PUT
        // and go straight to /complete with the etags the server has on file.
        const newEtags = [];
        if (missingParts.length === 0) {
            // No PUTs to run; proceed to /complete below with just the recorded parts.
        }
        else {
            // Step 3: For each batch of <=100 missing parts, re-presign + PUT.
            // We process batches sequentially (presign call) but PUTs within each
            // batch run concurrently up to multipartConcurrency, mirroring the
            // fresh-upload worker-pool semantics.
            const failureController = new AbortController();
            const putOne = async (part) => {
                // Offset math mirrors the fresh-upload path
                // (`multipartUpload`'s `uploadChunk`): part 1 is the initiate's 8 MiB
                // first chunk, parts 2..N each consume chunkSize bytes starting at
                // firstChunkSize. The resume path never PUTs part 1 (rejected
                // earlier as unrecoverable), so partNumber here is always >= 2.
                const firstChunkSize = Math.min(totalSize, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE);
                const start = firstChunkSize + (part.partNumber - 2) * chunkSize;
                const end = Math.min(start + chunkSize, totalSize);
                const contentLength = end - start;
                let chunk;
                try {
                    chunk = await source.slice(start, end);
                }
                catch (err) {
                    if (err instanceof GislAbortError)
                        throw err;
                    throw new GislMultipartPartError(`multipartResume: failed to read bytes for part ${part.partNumber}: ` +
                        (err instanceof Error ? err.message : String(err)), part.partNumber, status.uploadId);
                }
                let lastErr = null;
                for (let attempt = 0; attempt < this.multipartMaxAttempts; attempt++) {
                    if (options?.signal?.aborted) {
                        throw new GislAbortError(`multipartResume: S3 part ${part.partNumber} upload aborted`);
                    }
                    if (failureController.signal.aborted) {
                        throw new GislError(`multipartResume: S3 part ${part.partNumber} upload abandoned after sibling failure`);
                    }
                    let s3Response;
                    try {
                        s3Response = await fetch(part.url, {
                            method: 'PUT',
                            body: chunk,
                            headers: { 'Content-Length': contentLength.toString() },
                            signal: options?.signal,
                        });
                    }
                    catch (err) {
                        if (isAbortError(err) && options?.signal?.aborted) {
                            throw new GislAbortError(`multipartResume: S3 part ${part.partNumber} upload aborted`);
                        }
                        // Non-user-abort AbortError (e.g. transport cleanup) must still
                        // surface as a typed GislError subclass — never as a raw
                        // DOMException — to preserve the "every multipart failure is a
                        // typed GislError" contract (code-reviewer P7).
                        if (isAbortError(err)) {
                            throw new GislMultipartPartError(`multipartResume: S3 part ${part.partNumber} aborted by transport: ` +
                                (err instanceof Error ? err.message : String(err)), part.partNumber, status.uploadId);
                        }
                        if (isRetryableNetworkError(err)) {
                            lastErr = err;
                            if (attempt + 1 >= this.multipartMaxAttempts)
                                break;
                            const delay = fullJitterDelay(this.multipartRetryBaseMs, attempt);
                            await sleepWithEitherSignal(delay, options?.signal, failureController.signal);
                            continue;
                        }
                        throw err;
                    }
                    if (s3Response.ok) {
                        const etag = s3Response.headers.get('etag');
                        if (!etag) {
                            await drainResponseBody(s3Response);
                            throw new GislError(`multipartResume: S3 response missing ETag for part ${part.partNumber}`);
                        }
                        // Successful PUT — record etag, apply progress + checkpoint side
                        // effects OUTSIDE the retry-scoped path (mirrors the fresh-upload
                        // discipline at multipartUpload's ok-branch).
                        newEtags.push({ partNumber: part.partNumber, etag });
                        uploaded.set(part.partNumber, {
                            partNumber: part.partNumber,
                            etag,
                            sizeBytes: contentLength,
                            lastModified: new Date().toISOString(),
                        });
                        uploadedBytes = Math.min(uploadedBytes + contentLength, totalSize);
                        options?.onProgress?.(uploadedBytes, totalSize);
                        fireCheckpoint();
                        return;
                    }
                    await drainResponseBody(s3Response);
                    if (!isRetryableStatus(s3Response.status)) {
                        throw new GislError(`multipartResume: S3 chunk upload failed for part ${part.partNumber}: HTTP ${s3Response.status} (non-retryable)`);
                    }
                    lastErr = new GislError(`multipartResume: S3 chunk upload failed for part ${part.partNumber}: HTTP ${s3Response.status}`);
                    if (attempt + 1 >= this.multipartMaxAttempts)
                        break;
                    const delay = fullJitterDelay(this.multipartRetryBaseMs, attempt);
                    await sleepWithEitherSignal(delay, options?.signal, failureController.signal);
                }
                throw new GislMultipartPartError(`multipartResume: S3 chunk upload failed for part ${part.partNumber} after ${this.multipartMaxAttempts} attempts: ` +
                    (lastErr instanceof Error ? lastErr.message : String(lastErr)), part.partNumber, status.uploadId);
            };
            // Drive batches of <=100 part numbers.
            const PRESIGN_BATCH_SIZE = 100;
            for (let i = 0; i < missingParts.length; i += PRESIGN_BATCH_SIZE) {
                if (options?.signal?.aborted) {
                    throw new GislAbortError('multipartResume aborted');
                }
                const batch = missingParts.slice(i, i + PRESIGN_BATCH_SIZE);
                const presigned = await this.presignParts(status.uploadId, batch, status.totalParts, { signal: options?.signal });
                // Concurrent PUTs within the batch.
                const queue = [...presigned.presignedUrls];
                const workers = Array.from({ length: Math.min(this.multipartConcurrency, queue.length) }, async () => {
                    while (queue.length > 0 && !failureController.signal.aborted) {
                        if (options?.signal?.aborted) {
                            throw new GislAbortError('multipartResume aborted');
                        }
                        const part = queue.shift();
                        try {
                            await putOne(part);
                        }
                        catch (err) {
                            failureController.abort();
                            throw err;
                        }
                    }
                });
                await Promise.all(workers);
            }
        }
        // Step 4: /complete with the FULL parts list = (server-recorded etags
        // from /status) ∪ (newly-PUT etags this run). Sort ascending by
        // partNumber (the wire shape pin in fresh-upload mirrors this).
        const allParts = [];
        for (const p of status.uploadedParts) {
            allParts.push({ partNumber: p.partNumber, etag: p.etag });
        }
        for (const e of newEtags)
            allParts.push(e);
        allParts.sort((a, b) => a.partNumber - b.partNumber);
        if (allParts.length !== status.totalParts) {
            throw new GislError(`multipartResume: assembled parts list has ${allParts.length} entries, ` +
                `expected ${status.totalParts}. Refusing to /complete with an incomplete part set.`);
        }
        // Marshal via the generator's `*ToJSON` helper so the contracts-drift
        // guard test (`contract-drift-fields.test.ts`) covers BOTH the fresh and
        // resume paths uniformly (code-reviewer P7). If a future regen adds a
        // required field to `MultipartCompleteRequest`, tsc fails here at the
        // typed object literal — same as the fresh path.
        const completeRequest = {
            uploadId: status.uploadId,
            parts: allParts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
        };
        const wireCompleteBody = MultipartCompleteRequestToJSON(completeRequest);
        if (typeof wireCompleteBody?.upload_id !== 'string' ||
            !Array.isArray(wireCompleteBody?.parts)) {
            throw new GislError('multipartResume: MultipartCompleteRequestToJSON returned an unexpected shape.');
        }
        const completeResp = await this.request('POST', '/api/uploads/multipart/complete', {
            body: wireCompleteBody,
            deserialize: MultipartCompleteResponseFromJSON,
            signal: options?.signal,
        });
        if (completeResp.status !== 'completed') {
            throw new GislError(`multipartResume: completed with unexpected status: ${completeResp.status}`);
        }
        // Resume-path information loss: the /status envelope (and /complete)
        // do NOT carry `mime_type` or `constraints_applied` — those were
        // emitted on the original initiate envelope, which the resume path
        // skipped. Fall back to caller-supplied `fileName` for `originalName`;
        // emit `mimeType` as `''` and `constraintsApplied` as a sentinel
        // populated with the only fact we DO know on resume: `maxSizeBytes =
        // totalSize` (the upload was permitted at this size when initiated),
        // `processingClassPreAssignment = 'unknown'`. Consumers needing
        // authoritative post-upload metadata SHOULD call `getMetadata(fileId)`
        // (the fresh-upload path's docblock already says the same).
        // TODO(HxUmVr3Y): when contracts ships the resume-support schemas,
        // extend `/status` (or add `/multipart/{id}/manifest`) to carry
        // mime_type + constraints_applied so this sentinel can go away.
        return {
            fileId: completeResp.uploadId,
            originalName: fileName,
            mimeType: '',
            sizeBytes: totalSize,
            constraintsApplied: {
                maxSizeBytes: totalSize,
                // `maxDurationSeconds` deliberately omitted (not `null`): parity
                // comparator filters `undefined` keys from both sides; cross-SDK
                // upload_small precedent.
                processingClassPreAssignment: UploadConstraintsAppliedProcessingClassPreAssignmentEnum.unknown,
            },
        };
    }
    // -----------------------------------------------------------------------
    // SDK-3 (Wb6ebOMM) — resume-support endpoints
    // -----------------------------------------------------------------------
    /**
     * Fetch the durable status of an in-progress multipart upload session.
     *
     * Walks every page of `GET /api/uploads/multipart/{uploadId}/status`
     * (paginated via `next_part_number_marker` + `is_truncated`) and returns
     * the aggregated state. Callers see the complete set of recorded parts
     * across pages without driving the cursor themselves.
     *
     * Anonymous-initiated sessions return 403 → `GislMultipartSessionAuthRequiredError`.
     * Non-existent / expired sessions return 404 → `GislMultipartSessionNotFoundError`.
     * Authed-but-non-owning callers return 403 → `GislMultipartSessionOwnershipError`.
     *
     * TODO(HxUmVr3Y): replace hand-coded response shape on regen.
     */
    async getUploadStatus(uploadId, opts = {}) {
        if (typeof uploadId !== 'string' || uploadId === '') {
            throw new GislError('getUploadStatus: uploadId must be a non-empty string.');
        }
        return this.walkUploadStatus(uploadId, opts);
    }
    /**
     * Re-presign a batch of missing part numbers on an in-progress multipart
     * session.
     *
     * Validates client-side BEFORE the HTTP round-trip:
     * - `partNumbers` non-empty
     * - length <=100 (server raw-body cap is 8 KiB before json_decode)
     * - every entry an integer in `[2, totalParts]` — part 1 is sealed at
     *   initiate (re-presigning it would break the etag recorded server-side
     *   for /complete)
     * - entries unique
     * - `totalParts` <=10 000 (S3 hard limit; mirrors the SDK-1 ceiling guard)
     *
     * TODO(HxUmVr3Y): replace hand-coded request/response shapes on regen.
     */
    async presignParts(uploadId, partNumbers, totalParts, opts = {}) {
        if (typeof uploadId !== 'string' || uploadId === '') {
            throw new GislError('presignParts: uploadId must be a non-empty string.');
        }
        if (typeof totalParts !== 'number' ||
            !Number.isInteger(totalParts) ||
            totalParts < 1) {
            throw new GislError(`presignParts: totalParts must be a positive integer, got ${String(totalParts)}.`);
        }
        if (totalParts > S3_MAX_MULTIPART_PARTS) {
            throw new GislMultipartPartCountError(`presignParts: totalParts=${totalParts} exceeds the S3 ${S3_MAX_MULTIPART_PARTS}-part ` +
                'multipart limit. Refusing to re-presign on a session that cannot complete.', totalParts, S3_MAX_MULTIPART_PARTS);
        }
        if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
            throw new GislError('presignParts: partNumbers must be a non-empty array.');
        }
        if (partNumbers.length > 100) {
            throw new GislError(`presignParts: partNumbers has ${partNumbers.length} entries — server caps batches at 100.`);
        }
        const seen = new Set();
        for (const n of partNumbers) {
            if (typeof n !== 'number' ||
                !Number.isInteger(n) ||
                n < 2 ||
                n > totalParts) {
                throw new GislError(`presignParts: partNumbers entry ${String(n)} is not an integer in [2, ${totalParts}]. ` +
                    'Part 1 is sealed at initiate; re-presigning it would invalidate the recorded etag for /complete.');
            }
            if (seen.has(n)) {
                throw new GislError(`presignParts: partNumbers contains duplicate ${n}.`);
            }
            seen.add(n);
        }
        const path = `/api/uploads/multipart/${encodeURIComponent(uploadId)}/presign`;
        return this.request('POST', path, {
            // Hand-coded snake_case wire body. TODO(HxUmVr3Y): replace with
            // generated `*RequestToJSON` helper on regen.
            body: { part_numbers: [...partNumbers] },
            deserialize: (raw) => {
                // Hand-coded snake_case -> camelCase. TODO(HxUmVr3Y): replace with
                // generated FromJSON helper on regen.
                const r = raw;
                if (typeof r.upload_id !== 'string' || !Array.isArray(r.presigned_urls)) {
                    throw new GislError('presignParts: malformed response envelope.');
                }
                return {
                    uploadId: r.upload_id,
                    presignedUrls: r.presigned_urls.map((p) => ({
                        partNumber: p.part_number,
                        url: p.url,
                        expiresAt: p.expires_at,
                    })),
                };
            },
            signal: opts.signal,
        });
    }
    /**
     * Extend the manifest TTL of an in-progress multipart upload session.
     *
     * The durable session manifest defaults to a 48 h TTL (decoupled from the
     * shorter presigned-URL TTL). For a long-running resume that spans days
     * (e.g. an upload paused overnight on flaky Wi-Fi), callers SHOULD invoke
     * `keepaliveUpload` every **12-24 h** while resuming — the 12-24 h band
     * leaves >=24 h of slack against the 48 h ceiling even with worst-case
     * clock skew between client and server. The server atomically refreshes
     * the Redis EXPIRE for the manifest key; the call is idempotent.
     *
     * TODO(HxUmVr3Y): replace hand-coded response shape on regen.
     */
    async keepaliveUpload(uploadId, opts = {}) {
        if (typeof uploadId !== 'string' || uploadId === '') {
            throw new GislError('keepaliveUpload: uploadId must be a non-empty string.');
        }
        const path = `/api/uploads/multipart/${encodeURIComponent(uploadId)}/keepalive`;
        return this.request('POST', path, {
            // Server expects an empty body; pass an empty object so the `request`
            // helper sets `Content-Type: application/json` for symmetry with the
            // other JSON-bodied POSTs. The endpoint ignores any fields if present.
            body: {},
            deserialize: (raw) => {
                // Hand-coded snake_case -> camelCase. TODO(HxUmVr3Y): replace with
                // generated FromJSON helper on regen.
                const r = raw;
                if (typeof r.upload_id !== 'string' ||
                    typeof r.manifest_expires_at !== 'string') {
                    throw new GislError('keepaliveUpload: malformed response envelope.');
                }
                return {
                    uploadId: r.upload_id,
                    manifestExpiresAt: r.manifest_expires_at,
                };
            },
            signal: opts.signal,
        });
    }
    /**
     * Private walk-pagination helper for /status. Aggregates every page into
     * a single `_Sdk3HandCodedMultipartStatusResult`. AbortSignal short-circuits
     * the loop between page fetches AND propagates into each fetch.
     *
     * Limit pinned to 1000 (max per page) so we make the minimum number of
     * round-trips even for the worst-case ~10 pages on a 10 000-part upload.
     */
    async walkUploadStatus(uploadId, opts) {
        const PAGE_LIMIT = 1000;
        // Slow-path DoS guard (code-reviewer minor 6). The cursor-advance check
        // already prevents an infinite loop; this cap additionally prevents a
        // pathological server that advances by 1 each page from forcing
        // O(totalParts) round-trips for a 10 000-part upload. PAGE_LIMIT=1000
        // means a healthy server completes in <=10 round-trips; 50 leaves
        // generous slack.
        const MAX_PAGES = 50;
        const collected = [];
        let cursor = 0;
        let totalParts = 0;
        let multipartUploadId = '';
        let cloudKey = '';
        let manifestExpiresAt = '';
        let recommendedChunkSize = 0;
        let pageCount = 0;
        while (true) {
            if (opts.signal?.aborted) {
                throw new GislAbortError('getUploadStatus aborted');
            }
            if (pageCount >= MAX_PAGES) {
                throw new GislError(`getUploadStatus: server returned more than ${MAX_PAGES} pages — refusing to ` +
                    'continue. The /status endpoint should advance the cursor in 1000-part strides.');
            }
            pageCount += 1;
            const query = `?cursor=${cursor}&limit=${PAGE_LIMIT}`;
            // String-concat the query OUTSIDE the path backtick so the contract-drift
            // scanner (tests/unit/contract-drift.test.ts) sees the bare path
            // `/api/uploads/multipart/{id}/status`. Embedding `${query}` in the
            // template collapses to `/status{id}` and false-drifts — same reason
            // getSchema and getCreditsUsage concatenate their querystrings.
            const path = `/api/uploads/multipart/${encodeURIComponent(uploadId)}/status` + query;
            const page = await this.request('GET', path, { signal: opts.signal });
            // Defensive: server contract pins these fields. Strict-validate every
            // top-level field on each page (code-reviewer P7) so a malformed wire
            // envelope cannot silently coerce a missing key to '' / 0 / NaN and
            // flow it into MultipartCheckpointState.manifestExpiresAt or downstream
            // chunkSize guards.
            if (typeof page.total_parts !== 'number' || page.total_parts < 1) {
                throw new GislError('getUploadStatus: server page missing or invalid total_parts.');
            }
            if (typeof page.upload_id !== 'string' ||
                page.upload_id !== uploadId ||
                typeof page.multipart_upload_id !== 'string' ||
                page.multipart_upload_id === '' ||
                typeof page.cloud_key !== 'string' ||
                page.cloud_key === '' ||
                typeof page.manifest_expires_at !== 'string' ||
                page.manifest_expires_at === '' ||
                typeof page.recommended_chunk_size !== 'number') {
                throw new GislError('getUploadStatus: server page missing required fields or returned a ' +
                    `mismatching upload_id (expected ${uploadId}, got ` +
                    `${String(page.upload_id)}).`);
            }
            totalParts = page.total_parts;
            multipartUploadId = page.multipart_upload_id;
            cloudKey = page.cloud_key;
            manifestExpiresAt = page.manifest_expires_at;
            recommendedChunkSize = page.recommended_chunk_size;
            for (const p of page.uploaded_parts ?? []) {
                collected.push({
                    partNumber: p.part_number,
                    etag: p.etag,
                    sizeBytes: p.size_bytes,
                    lastModified: p.last_modified,
                });
            }
            if (!page.is_truncated)
                break;
            // Advance cursor; guard against a contract-violating non-advancing
            // marker that would loop forever.
            if (typeof page.next_part_number_marker !== 'number' ||
                page.next_part_number_marker <= cursor) {
                throw new GislError('getUploadStatus: server is_truncated=true but next_part_number_marker ' +
                    `did not advance (was ${cursor}, got ${String(page.next_part_number_marker)}).`);
            }
            cursor = page.next_part_number_marker;
        }
        // Sort ascending by partNumber — server SHOULD already deliver in order
        // page-by-page, but a defensive sort keeps the aggregated shape's
        // contract simple to consume (resume-branch missing-parts compute scans
        // it linearly).
        collected.sort((a, b) => a.partNumber - b.partNumber);
        return {
            uploadId,
            multipartUploadId,
            cloudKey,
            totalParts,
            uploadedParts: collected,
            manifestExpiresAt,
            recommendedChunkSize,
        };
    }
    // -----------------------------------------------------------------------
    // Workflows
    // -----------------------------------------------------------------------
    /**
     * Create a new workflow.
     */
    async createWorkflow(payload) {
        return this.request('POST', '/api/workflows', {
            body: payload,
            deserialize: WorkflowCreateResponseFromJSON,
        });
    }
    /**
     * Get current workflow status.
     *
     * For an anonymous (null-owner) workflow, pass `opts.capability` (the `cap`
     * from the anonymous workflow-create response) so a session-less caller can
     * read it — the SDK sends it as the `X-Workflow-Capability` header. Omit for
     * authenticated reads. A wrong/missing cap on a null-owner workflow is a 404.
     */
    async getWorkflowStatus(workflowId, opts = {}) {
        return this.request('GET', `/api/workflows/${encodeURIComponent(workflowId)}/status`, {
            deserialize: WorkflowStatusResponseFromJSON,
            headers: workflowCapabilityHeaders(opts.capability),
        });
    }
    /**
     * Poll until the workflow reaches a terminal status.
     */
    async waitForWorkflow(workflowId, options) {
        const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        const timeoutMs = options?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;
        while (true) {
            const status = await this.getWorkflowStatus(workflowId, {
                capability: options?.capability,
            });
            options?.onPoll?.(status.status);
            if (TERMINAL_STATUSES.has(status.status)) {
                return status;
            }
            if (Date.now() + intervalMs > deadline) {
                throw new GislTimeoutError(`Workflow ${workflowId} did not complete within ${timeoutMs}ms`);
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    /**
     * Cancel a workflow. Idempotent — cancelling an already-cancelled
     * workflow returns 200 with the same shape (and the original
     * `cancelledAt`). Cancelling a `completed` / `failed` /
     * `partially_failed` / `expired` workflow returns 409.
     *
     * The response's `billingEffect` field tells the caller what
     * happened to outstanding reservations:
     * - `unspent_reservation_released` — workflow was active or paused
     *   and the unspent portion of the reservation has been refunded.
     *   The refund appears as a separate `CreditTransaction` with
     *   `type: refund`.
     * - `none` — no refund (all reserved credits were already consumed
     *   by completed jobs, or this is an idempotent re-cancel).
     *
     * In-flight operations may continue running briefly after the
     * cancel response while their Lambda processes terminate; the
     * response is the binding "no further reservations will be made"
     * signal.
     */
    async cancelWorkflow(workflowId) {
        return this.request('POST', `/api/workflows/${encodeURIComponent(workflowId)}/cancel`, {
            deserialize: WorkflowCancelResponseFromJSON,
        });
    }
    /**
     * Resume a workflow that is in `paused_insufficient_credits`.
     *
     * Resume succeeds only when `availableCredits` covers the next
     * reservation. If the balance is still insufficient, throws
     * `GislBalanceExhaustedError` (402, same envelope as the workflow-
     * create 402 path) and the workflow stays paused. If the workflow
     * is past its `expiresAt` (default 7-day TTL from `pausedAt`),
     * throws `GislWorkflowExpiredError` (422) and the workflow has
     * transitioned to `expired` — callers cannot un-expire a workflow.
     * Resuming a workflow that is not in `paused_insufficient_credits`
     * is a 409 (no-op).
     */
    async resumeWorkflow(workflowId) {
        return this.request('POST', `/api/workflows/${encodeURIComponent(workflowId)}/resume`, {
            deserialize: WorkflowResumeResponseFromJSON,
        });
    }
    /**
     * Get download URLs for a completed workflow.
     *
     * For an anonymous (null-owner) workflow, pass `opts.capability` (the `cap`
     * from the anonymous workflow-create response) so a session-less caller can
     * read it — the SDK sends it as the `X-Workflow-Capability` header. Omit for
     * authenticated reads. A wrong/missing cap on a null-owner workflow is a 404.
     */
    async getWorkflowDownloads(workflowId, opts = {}) {
        return this.request('GET', `/api/workflows/${encodeURIComponent(workflowId)}/downloads`, {
            deserialize: WorkflowDownloadResponseFromJSON,
            headers: workflowCapabilityHeaders(opts.capability),
        });
    }
    /**
     * Stream SSE events for a workflow. Returns an async iterable.
     *
     * For an anonymous (null-owner) workflow, pass `opts.capability` (the `cap`
     * from the anonymous workflow-create response) so a session-less caller can
     * read it — the SDK sends it as the `X-Workflow-Capability` header. Omit for
     * authenticated reads. A wrong/missing cap on a null-owner workflow is a 404.
     */
    async streamEvents(workflowId, opts = {}) {
        const eventsPath = `/api/workflows/${encodeURIComponent(workflowId)}/events`;
        // SSE-lifetime AbortController. `request()` builds its own controller
        // and tears it down (`clearTimeout(timer); unbind()`) in its `finally`
        // the instant the response headers arrive — BEFORE the SSE body
        // streams — so that controller cannot cancel a long-lived stream.
        // `streamEvents` must own a controller for the stream's whole lifetime.
        // We pass its signal to `request()` too, so a pre-aborted signal /
        // connect-phase abort still fast-fails. After headers, the live socket
        // is freed only by `reader.cancel()` inside `parseSseStream` — driven
        // by aborting this controller from the iterator wrapper's
        // `return()`/`throw()` (a generator's own `return()` is unreachable
        // while suspended at `await reader.read()`; canonical pattern:
        // openai-node `Stream[Symbol.asyncIterator]` + PR #1314).
        const controller = new AbortController();
        // Compose an optional consumer-supplied signal onto our controller.
        // The teardown MUST run (normal completion, error, OR early return)
        // or a long-lived consumer AbortController leaks listeners.
        const releaseConsumerSignal = bindAbortSignal(opts.signal, controller);
        let response;
        try {
            response = await this.request('GET', eventsPath, {
                rawResponse: true,
                signal: controller.signal,
                headers: workflowCapabilityHeaders(opts.capability),
            });
        }
        catch (err) {
            releaseConsumerSignal();
            throw err;
        }
        if (!response.ok) {
            try {
                await this.handleResponse(response, eventsPath); // always throws
            }
            finally {
                releaseConsumerSignal();
            }
        }
        const inner = parseSseStream(response, {
            signal: controller.signal,
            ...(opts.onParseError !== undefined ? { onParseError: opts.onParseError } : {}),
        });
        let started = false;
        let settled = false;
        // Idempotent teardown. `abort` only on consumer-driven early
        // termination (return/throw) — NOT on normal completion or stream
        // error, where aborting would be a spurious "aborted though it
        // wasn't" signal (openai-node#194). If the consumer disposes the
        // iterator before ever pulling an event, the inner generator never
        // ran, so its `finally` won't cancel the body — cancel it here as a
        // backstop (the body is still unlocked: no reader was acquired).
        const cleanup = (abort) => {
            if (settled)
                return;
            settled = true;
            if (abort)
                controller.abort();
            if (!started)
                void response.body?.cancel().catch(() => { });
            releaseConsumerSignal();
        };
        // Abort-before-first-pull backstop. If the consumer aborts (their
        // signal, composed onto `controller`) and then drops the iterator
        // WITHOUT ever calling next()/return()/throw(), nothing else frees the
        // already-fetched body: `request()` unbound its fetch controller at
        // header receipt, and `parseSseStream` only attaches its reader +
        // abort listener once iteration starts. `cleanup`'s `!started` branch
        // only runs from the wrapper methods, so it never fires on a pure
        // abort-and-drop. Cancel the (still-unlocked) body directly here.
        // Once started, `parseSseStream` owns the locked reader and cancels
        // via its own abort listener, so this no-ops.
        controller.signal.addEventListener('abort', () => {
            if (!started)
                void response.body?.cancel().catch(() => { });
        }, { once: true });
        const wrapper = {
            async next(...args) {
                started = true;
                try {
                    const result = await inner.next(...args);
                    if (result.done)
                        cleanup(false);
                    return result;
                }
                catch (err) {
                    cleanup(false);
                    throw err;
                }
            },
            async return(value) {
                cleanup(true);
                return inner.return(value);
            },
            async throw(err) {
                cleanup(true);
                return inner.throw(err);
            },
            [Symbol.asyncIterator]() {
                return this;
            },
        };
        return wrapper;
    }
    // -----------------------------------------------------------------------
    // File metadata
    // -----------------------------------------------------------------------
    /**
     * Get metadata for an uploaded file.
     */
    async getMetadata(fileId) {
        return this.request('GET', `/api/uploads/${encodeURIComponent(fileId)}/metadata`, {
            deserialize: MetadataResponseFromJSON,
        });
    }
    // -----------------------------------------------------------------------
    // Operations
    // -----------------------------------------------------------------------
    /**
     * Get the operations schema (available types, options, constraints).
     *
     * Returns raw JSON (no envelope). The response is **per-tier private**
     * (cache key includes the caller's `user_tier`); CDN-style public
     * caching is not used. Pass `ifNoneMatch` / `ifModifiedSince` from a
     * previous response to revalidate — a 304 surfaces as
     * `{ notModified: true, etag, lastModified }` so callers can keep
     * using their cached copy.
     *
     * NOTE: this schema describes available types/options/availability — it does
     * NOT carry per-tier processing-class size/duration caps (the response shape
     * has no `processing_class` / `per_tier_constraints`). The typed operation
     * metadata's `AvailabilityEntry.constraints` is the conservative baseline
     * only. Per-tier caps are enforced server-side: the caps that applied to an
     * upload are reported on a successful `UploadResponse.constraintsApplied`,
     * and an exceeded limit throws `GislUploadCapExceededError` (the 422 path
     * carries a typed payload; the 413 absolute-cap path is a plain envelope).
     * There is no read-ahead per-tier-cap API today.
     */
    async getSchema(options = {}) {
        const params = new URLSearchParams();
        if (options.mimeType !== undefined)
            params.set('mime_type', options.mimeType);
        if (options.operation !== undefined)
            params.set('operation', options.operation);
        const query = params.toString();
        // The contract-drift test (tests/unit/contract-drift.test.ts) scans this
        // file for path literals via a regex that picks up both single-quoted
        // strings AND backtick templates. Embedding the querystring in a single
        // template would normalise to a path-with-querystring that no contract
        // path matches. Compose with concatenation so only the bare path appears
        // as a literal.
        const path = '/api/operations/schema' + (query ? '?' + query : '');
        const headers = {};
        if (options.ifNoneMatch !== undefined)
            headers['If-None-Match'] = options.ifNoneMatch;
        if (options.ifModifiedSince !== undefined)
            headers['If-Modified-Since'] = options.ifModifiedSince;
        const response = await this.request('GET', path, {
            rawResponse: true,
            signal: options.signal,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
        });
        const etag = response.headers.get('etag') ?? undefined;
        const lastModified = response.headers.get('last-modified') ?? undefined;
        if (response.status === 304) {
            return { notModified: true, etag, lastModified };
        }
        if (!response.ok) {
            let errorMessage = 'Unknown error';
            let errorCode;
            try {
                const errJson = (await response.json());
                // Prefer the human `message`; `error` is the machine code (x9Lbf6uy).
                if (errJson.message)
                    errorMessage = errJson.message;
                else if (errJson.error)
                    errorMessage = errJson.error;
                // Surface the machine code as errorCode too (parity with handleResponse
                // + PHP), even when `message` supplied the human text.
                if (typeof errJson.error === 'string')
                    errorCode = errJson.error;
            }
            catch {
                // Non-JSON body — keep generic message, no machine code.
            }
            // This throw is OUTSIDE handleResponse (rawResponse:true / 304 path), so
            // build the response-header surface from the in-scope `response` here.
            throw new GislApiError(response.status, errorMessage, path, undefined, {
                errorCode,
                responseHeaders: headersToRecord(response.headers),
                contentLanguage: response.headers.get('content-language') ?? undefined,
            });
        }
        const raw = await response.json();
        const data = OperationsSchemaResponseFromJSON(raw);
        return { notModified: false, data, etag, lastModified };
    }
    /**
     * Retry a failed operation.
     */
    async retryOperation(operationId) {
        return this.request('POST', `/api/operations/${encodeURIComponent(operationId)}/retry`, {
            deserialize: RetryResponseFromJSON,
        });
    }
    // -----------------------------------------------------------------------
    // Contact
    // -----------------------------------------------------------------------
    /**
     * Submit a contact-form message. The endpoint returns 204 No Content on
     * success, so this method resolves to `void`.
     *
     * Validation errors (e.g. missing `email`, non-empty honeypot `website`)
     * surface as `GislValidationError` from the standard error envelope.
     */
    async submitContact(payload) {
        await this.request('POST', '/api/contact', {
            body: payload,
        });
    }
    // -----------------------------------------------------------------------
    // Credits / billing
    // -----------------------------------------------------------------------
    /**
     * Get a snapshot of the caller's current credit position. The canonical
     * billing-state surface — `BalanceExhaustedResponse` (402) on workflow
     * creation includes pre-error counters for context, but UIs should drive
     * spend-now affordances and tier-upgrade prompts off this endpoint, not
     * off the error envelope.
     */
    async getCreditsBalance() {
        return this.request('GET', '/api/v2/credits/balance', {
            deserialize: CreditsBalanceResponseFromJSON,
        });
    }
    /**
     * Fetch the caller's effective account limits (the tier-resolved caps:
     * upload/merge size + total caps, surfaced override-aware). `GET
     * /api/v2/account/limits`. The success envelope's `data` is unwrapped to the
     * {@link AccountLimits} model (mirrors {@link getCreditsBalance}).
     */
    async getAccountLimits() {
        return this.request('GET', '/api/v2/account/limits', {
            deserialize: AccountLimitsFromJSON,
        });
    }
    // -----------------------------------------------------------------------
    // Auth
    // -----------------------------------------------------------------------
    /**
     * Authenticate with email/password. On success the server issues a
     * session cookie via `Set-Cookie`; subsequent requests authenticate
     * via that cookie when the client is configured with
     * `useSessionCookie: true`.
     *
     * Failure modes per ticket FX6mbTJD:
     * - **401** `invalid_credentials` (collapsed with unverified
     *   accounts for anti-enumeration) → `GislAuthError`.
     * - **403** account-state failures (`account_locked`,
     *   `account_disabled`, `account_deleted`,
     *   `account_deletion_expired`) → `GislAuthError`.
     * - **429** infrastructure rate-limit → `GislApiError` with
     *   the `Retry-After` header echoed on the response.
     *
     * Node session persistence (cookie-jar across processes) is out of
     * scope — this method only touches the request side.
     */
    async login(credentials) {
        return this.request('POST', '/api/auth/login', {
            body: credentials,
            deserialize: LoginUser200ResponseDataFromJSON,
        });
    }
    /**
     * Invalidate the current session.
     *
     * Idempotent: calling logout without an active session returns 401,
     * but the SDK collapses both 200 and 401 into a single "logged out"
     * outcome — `logout()` resolves to `void` in either case so caller
     * cleanup code does not need to special-case the not-currently-
     * authenticated path. Other errors (e.g. 500, network failures)
     * still throw.
     */
    async logout() {
        try {
            await this.request('POST', '/api/auth/logout', {});
        }
        catch (err) {
            // Treat 401 as success (already logged out — idempotent per
            // contract). Logout 401 is a bare ErrorEnvelope with no
            // `error_type`, so it surfaces as the base GislApiError rather
            // than the typed GislAuthError — match on the status code to
            // capture both shapes.
            if (err instanceof GislApiError && err.statusCode === 401) {
                return;
            }
            throw err;
        }
    }
    // -----------------------------------------------------------------------
    // External imports
    // -----------------------------------------------------------------------
    /**
     * Register a one-shot bearer URL (S3 presigned, GCS signed, Azure
     * SAS, Dropbox shared link, public HTTPS) and receive an opaque
     * `externalSourceId` handle. Subsequent workflows reference the
     * handle via `WorkflowSource` of `type: external_import` —
     * compose with the [`externalImportSource()`](./types.ts) factory.
     *
     * Per ADR-0005 §"SSRF posture": the server validates 8 rules at
     * registration time AND again at fetch time. HTTPS-only;
     * private/loopback/cloud-metadata IPs are rejected (403). The
     * original URL + password are encrypted at rest and never
     * returned in any response.
     *
     * Currently `availability: planned` — the runtime endpoint returns
     * 422 `feature_not_available` (or 404, per the cross-repo rollout)
     * until the external-import infrastructure ships. The method
     * exists today so consumers can write the integration ahead of
     * time.
     *
     * Auth-ownership: the import id this returns is owned by the
     * authenticated caller that created it. Referencing it from a client
     * with a different auth context 404s `upload_not_found` at
     * workflow-create — same ownership rule as `fileInput.uploadId` (api
     * PqpD9ySv).
     */
    async createExternalImport(payload) {
        return this.request('POST', '/api/external-imports', {
            body: ExternalImportRequestToJSON(payload),
            deserialize: ExternalImportCreatedResponseFromJSON,
        });
    }
    // -----------------------------------------------------------------------
    // Audio watermark
    // -----------------------------------------------------------------------
    /**
     * Decode a previously-embedded steganographic audio watermark
     * (per ticket I20). Pairs with the `audio_watermark` operation —
     * the operation embeds; this endpoint decodes.
     *
     * **Enterprise tier only.** Free / pro callers receive
     * `GislFeatureTierRestrictedError` (403).
     *
     * **Own watermarks only.** The decoder will refuse to extract from
     * media the caller did not mark themselves — mismatches return 404
     * (rather than leaking that *some* watermark was detected).
     *
     * Currently `availability: planned` — calls return
     * `GislFeatureNotAvailableError` (422) until the cross-repo Lambda
     * support ships. Decode requests are rate-limited independently
     * from workflow-create.
     */
    async decodeAudioWatermark(payload) {
        // The generated request type is camelCase; convert to snake_case wire
        // shape before sending. Mirrors the multipart complete pattern.
        return this.request('POST', '/api/audio-watermark/decode', {
            body: AudioWatermarkDecodeRequestToJSON(payload),
            deserialize: AudioWatermarkDecodeResponseFromJSON,
        });
    }
    // -----------------------------------------------------------------------
    // Upload probe / preflight
    // -----------------------------------------------------------------------
    /**
     * Probe an uploaded file for workflow-readiness — detects corruption,
     * unsupported codecs, and pre-assigns the processing class the server
     * would route the file to. For video uploads the probe also lands the
     * codec + duration the server needs to admit the parallel split, so
     * calling this (or {@link waitForProbe}) before workflow-create is the
     * structural unlock for the fast video path on the multipart flow.
     *
     * Endpoint availability is `stable`. The probe runs asynchronously after
     * upload: until the result has landed, this returns `422`
     * `feature_not_available` (surfaced as {@link GislFeatureNotAvailableError})
     * — i.e. that 422 means "probe not landed yet", NOT "not implemented". Once
     * landed it returns a `200` with any `probeStatus`. Idempotent: probing the
     * same `fileId` twice returns the cached result. See {@link waitForProbe}
     * for a bounded poll that turns this into a single ready/gave-up answer.
     */
    async probeUpload(fileId, options = {}) {
        return this.request('POST', `/api/uploads/${encodeURIComponent(fileId)}/probe`, {
            deserialize: UploadProbeResponseFromJSON,
            signal: options.signal,
        });
    }
    /**
     * Bounded poll of {@link probeUpload} until the probe lands — the helper
     * frontends call between upload-complete and workflow-create so the server
     * sees the video's codec + duration and admits the ~3× parallel split.
     *
     * Loop (per the API wire contract):
     * - `422 feature_not_available` → probe not landed yet → keep polling
     *   (exponential full-jitter backoff, honouring a `Retry-After` header when
     *   present, clamped to the remaining budget).
     * - any `200` → STOP. Resolves `{ landed: true, probe }` regardless of
     *   `probeStatus` (ok / corrupt / unsupported_codec / missing_metadata) —
     *   the server + fan-out gate decide split-vs-single from the landed
     *   metadata; the SDK does not interpret it.
     * - `5xx` (prober crash) → retry a couple of times, then give up.
     * - timeout → give up.
     *
     * **Never bounces:** on give-up (timeout / repeated 5xx / transport) it
     * resolves `{ landed: false, reason }` rather than throwing, so the caller
     * proceeds to create the workflow anyway (the server's size heuristic routes
     * it; worst case = today's single-task behaviour). Genuine failures —
     * `404 upload_not_found`, auth errors, or caller abort — DO propagate (they
     * are not "probe not ready"), so a real problem is never silently swallowed.
     *
     * `timeoutMs` bounds the OVERALL poll, checked between attempts; each
     * in-flight probe request is bounded by the client's own per-request timeout
     * (a hung request surfaces as a transient and the next deadline check gives
     * up). So a single slow probe may run up to one client-request-timeout before
     * the wait returns.
     */
    async waitForProbe(fileId, options = {}) {
        const timeoutMs = sanitiseBaseMs(options.timeoutMs, 30_000);
        const signal = options.signal;
        const start = Date.now();
        const deadline = start + timeoutMs;
        const BASE_BACKOFF_MS = 250;
        const MAX_PROBER_RETRIES = 2;
        let attempt = 0;
        // Counts transient probe-call failures (5xx + transport + per-request
        // timeout) — repeated transients give up so the caller creates anyway
        // (never-bounce).
        let transientFailures = 0;
        for (;;) {
            if (signal?.aborted)
                throw new GislAbortError('waitForProbe aborted');
            const remainingBeforeAttempt = deadline - Date.now();
            if (remainingBeforeAttempt <= 0)
                return { landed: false, reason: 'timeout' };
            attempt += 1;
            options.onPoll?.({ attempt, elapsedMs: Date.now() - start });
            let retryAfterMs;
            try {
                const probe = await this.probeUpload(fileId, { signal });
                return { landed: true, probe };
            }
            catch (err) {
                // A CALLER abort always propagates (it is not "probe not ready").
                if (signal?.aborted) {
                    throw err instanceof GislAbortError ? err : new GislAbortError('waitForProbe aborted');
                }
                if (err instanceof GislFeatureNotAvailableError) {
                    // Not landed yet — keep polling.
                    retryAfterMs = parseRetryAfterMs(err.responseHeaders?.['retry-after']);
                }
                else if ((err instanceof GislApiError && err.statusCode >= 500) ||
                    err instanceof GislTimeoutError ||
                    isRetryableNetworkError(err)) {
                    // Transient probe-call failure — a 5xx, the client's own per-request
                    // timeout, or a transport error. Retry a couple of times, then give
                    // up (never-bounce: the caller creates anyway).
                    transientFailures += 1;
                    if (transientFailures > MAX_PROBER_RETRIES) {
                        return { landed: false, reason: 'prober_error' };
                    }
                    retryAfterMs =
                        err instanceof GislApiError
                            ? parseRetryAfterMs(err.responseHeaders?.['retry-after'])
                            : undefined;
                }
                else {
                    // 404 upload_not_found, auth, validation, or any other typed/unexpected
                    // error is a real failure, not "probe not ready" — propagate.
                    throw err;
                }
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                return { landed: false, reason: 'timeout' };
            const backoff = retryAfterMs ?? fullJitterDelay(BASE_BACKOFF_MS, attempt - 1);
            await cancellableSleep(Math.min(backoff, remaining), signal);
            if (Date.now() >= deadline)
                return { landed: false, reason: 'timeout' };
        }
    }
    /**
     * Best-effort probe-before-create for a VIDEO upload that went multipart.
     * No-op unless enabled AND isVideo AND the upload exceeded the multipart
     * threshold (i.e. it was a multipart upload — small single-shot videos skip
     * the wait). Delegates to {@link waitForProbe} (never-bounce): a give-up just
     * returns; genuine failures / caller abort propagate. The caller passes
     * `isVideo` so the low-level client never imports ergonomic media detection.
     */
    async maybeWaitForVideoProbe(fileId, opts) {
        if (!opts.enabled || !opts.isVideo)
            return;
        if (opts.sizeBytes === undefined || opts.sizeBytes <= this.multipartThreshold)
            return;
        await this.waitForProbe(fileId, { timeoutMs: opts.timeoutMs, signal: opts.signal });
    }
    /**
     * Probe N uploaded files in parallel and partition the results by
     * outcome. Returns `{ ok, rejected, errors }` so the caller can
     * cleanly drop bad clips before submitting a long-form merge
     * workflow. Probe-call failures (including the
     * `feature_not_available` 422 returned while the endpoint is
     * `availability: planned`) land in `errors` rather than throwing,
     * so a partially-successful batch still yields useful aggregation.
     */
    async preflightClips(fileIds) {
        const settled = await Promise.allSettled(fileIds.map((fileId) => this.probeUpload(fileId)));
        const ok = [];
        const rejected = [];
        const errors = [];
        for (let i = 0; i < settled.length; i++) {
            const result = settled[i];
            const fileId = fileIds[i];
            if (result.status === 'fulfilled') {
                if (result.value.probeStatus === 'ok') {
                    ok.push(result.value);
                }
                else {
                    rejected.push(result.value);
                }
            }
            else {
                errors.push({ fileId, error: result.reason });
            }
        }
        return { ok, rejected, errors };
    }
    /**
     * Get a paginated page of credit transaction history for the caller.
     * Server defaults: `limit=20`, `offset=0`. Most-recent-first.
     */
    async getCreditsUsage(options = {}) {
        const params = new URLSearchParams();
        if (options.limit !== undefined)
            params.set('limit', String(options.limit));
        if (options.offset !== undefined)
            params.set('offset', String(options.offset));
        const query = params.toString();
        // String concatenation (not template) so the contract-drift path scanner
        // picks up the literal path. See getSchema for the same pattern.
        const path = query.length > 0
            ? '/api/v2/credits/usage' + '?' + query
            : '/api/v2/credits/usage';
        return this.request('GET', path, {
            deserialize: CreditsUsageResponseFromJSON,
        });
    }
    /**
     * List the caller's workflows — a cursor-paginated, user-scoped summary
     * list, most-recent-first. Each row is a lightweight {@link WorkflowSummary}
     * (id / status / created_at + per-job type+status + a deliverable-output
     * count); it does NOT inline per-op `result_metadata` or output details —
     * drill in via {@link getWorkflowStatus} / {@link getWorkflowDownloads}.
     *
     * Auth is REQUIRED (the list is user-scoped; an anonymous caller gets a 401
     * → `GislAuthError`). Walk pages by passing each response's `nextCursor` as
     * the next call's `cursor` until `isTruncated` is false, or use
     * {@link workflows} to auto-paginate. Mirrors the PHP
     * `GislClient::listWorkflows`.
     */
    async listWorkflows(options = {}) {
        const params = new URLSearchParams();
        // Guard `null` too — runtime (untyped) callers may pass `cursor: null`,
        // which must be omitted, not serialised as the literal string "null".
        if (options.cursor !== undefined && options.cursor !== null && options.cursor !== '') {
            params.set('cursor', options.cursor);
        }
        if (options.limit !== undefined)
            params.set('limit', String(options.limit));
        const query = params.toString();
        // String concatenation (not template) so the contract-drift path scanner
        // picks up the literal path. See getCreditsUsage for the same pattern.
        const path = query.length > 0 ? '/api/workflows' + '?' + query : '/api/workflows';
        return this.request('GET', path, {
            deserialize: WorkflowListResponseFromJSON,
        });
    }
    /**
     * Auto-paginating async iterator over ALL of the caller's workflows,
     * yielding each {@link WorkflowSummary} most-recent-first across page
     * boundaries — the ergonomic companion to {@link listWorkflows}. Walks
     * `nextCursor` until the server reports `isTruncated: false`. Mirrors the
     * PHP `workflows()` generator.
     *
     * ```ts
     * for await (const wf of client.workflows()) {
     *   console.log(wf.workflowId, wf.status);
     * }
     * ```
     */
    async *workflows(options = {}) {
        let cursor;
        for (;;) {
            const page = await this.listWorkflows({ cursor, limit: options.limit });
            for (const summary of page.workflows) {
                yield summary;
            }
            const next = page.nextCursor;
            // Stop on a final page, an empty cursor, OR a non-advancing cursor — a
            // server that repeats the same cursor on a truncated page would
            // otherwise loop forever, refetching + re-yielding the same rows.
            if (!page.isTruncated || next === undefined || next === null || next === '' || next === cursor) {
                return;
            }
            cursor = next;
        }
    }
}
