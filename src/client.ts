import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import {
  UploadResponseFromJSON,
  MultipartInitiateResponseFromJSON,
  MultipartInitiateRequestMetadataHintToJSON,
  MultipartCompleteResponseFromJSON,
  MultipartCompleteRequestToJSON,
  WorkflowCreateResponseFromJSON,
  WorkflowStatusResponseFromJSON,
  WorkflowDownloadResponseFromJSON,
  MetadataResponseFromJSON,
  OperationsSchemaResponseFromJSON,
  RetryResponseFromJSON,
  WorkflowStatus,
  AuthErrorResponseFromJSON,
  AuthErrorType,
  BalanceExhaustedResponseFromJSON,
  BalanceExhaustedResponseRequiredActionEnum,
  FeatureNotAvailableResponseFromJSON,
  FeatureTierRestrictedResponseFromJSON,
  TierRestrictionKind,
  TierRestrictionResponseFromJSON,
  UserTier,
  WorkflowExpiredResponseFromJSON,
  UploadThresholdsSingleShotMaxBytesEnum,
  UploadThresholdsMultipartChunkSizeEnum,
  UploadThresholdsMultipartConcurrencyDefaultEnum,
} from '@giveitsmaller/contracts/openapi';

import type {
  ContactRequest,
  UploadResponse,
  MultipartInitiateResponse,
  MultipartCompleteResponse,
  MultipartCompleteRequest,
  WorkflowCreateResponse,
  WorkflowStatusResponse,
  WorkflowDownloadResponse,
  MetadataResponse,
  RetryResponse,
} from '@giveitsmaller/contracts/openapi';

import {
  GislAbortError,
  GislApiError,
  type GislApiErrorOptions,
  GislAuthError,
  GislBalanceExhaustedError,
  GislError,
  GislFeatureNotAvailableError,
  GislFeatureTierRestrictedError,
  GislTierRestrictedError,
  GislTimeoutError,
  GislValidationError,
  GislWorkflowExpiredError,
} from './errors.js';
import { parseSseStream } from './sse.js';
import type {
  GetSchemaOptions,
  GetSchemaResult,
  GislClientConfig,
  GislSseEvent,
  UploadOptions,
  WaitOptions,
  WorkflowCreatePayload,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
// SDK-internal aliases derived from the contract-pinned UploadThresholds enums
// (compression_contracts/openapi schema `UploadThresholds`, ticket u0ar7Yye).
// `satisfies number` keeps the literal type so the drift guards below pin the
// expected value at compile time. Bumping any of these requires a contracts
// release that regenerates the corresponding *Enum, plus updating the literal
// in the matching `_AssertTrue<>` line.
const SINGLE_SHOT_MAX_BYTES =
  UploadThresholdsSingleShotMaxBytesEnum.NUMBER_10000000 satisfies number;
const MULTIPART_CHUNK_SIZE =
  UploadThresholdsMultipartChunkSizeEnum.NUMBER_5242880 satisfies number;
const MULTIPART_CONCURRENCY_DEFAULT =
  UploadThresholdsMultipartConcurrencyDefaultEnum.NUMBER_4 satisfies number;

// Compile-time drift guards: pin the literal value of each constant so a
// future contracts regen that changes the enum member breaks the build here
// rather than silently shifting SDK behaviour. Mirrors the
// WORKFLOW_CREATE_PAYLOAD_KEYS pattern in types.ts.
type _AssertTrue<T extends true> = T;
type _SingleShotMaxBytesIsTenMillion =
  typeof SINGLE_SHOT_MAX_BYTES extends 10_000_000 ? true : false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertSingleShotMaxBytes = _AssertTrue<_SingleShotMaxBytesIsTenMillion>;
type _MultipartChunkSizeIsFiveMiB =
  typeof MULTIPART_CHUNK_SIZE extends 5_242_880 ? true : false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertMultipartChunkSize = _AssertTrue<_MultipartChunkSizeIsFiveMiB>;
type _MultipartConcurrencyDefaultIsFour =
  typeof MULTIPART_CONCURRENCY_DEFAULT extends 4 ? true : false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AssertMultipartConcurrencyDefault =
  _AssertTrue<_MultipartConcurrencyDefaultIsFour>;

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
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 300_000; // 5 min

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  WorkflowStatus.completed,
  WorkflowStatus.failed,
  WorkflowStatus.partially_failed,
]);

// Wire-shape guard for ValidationErrorEnvelopeDetailsInner. The v2 contract
// only requires `message`; `field` / `operation` / `option` are all optional
// (per `compression_contracts/openapi/api.yaml` -- a cross-field validation
// error may identify the violation by `operation` + `option` alone). Earlier
// versions of this guard required `field` too, which silently misrouted
// per-option validation envelopes to the base `GislApiError`.
export interface ValidationDetail {
  message: string;
  field?: string;
  operation?: string;
  option?: string;
  messageKey?: string;
  locale?: string;
  messageParams?: Record<string, unknown>;
}

function isValidationDetails(value: unknown): value is ValidationDetail[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (el) =>
        typeof el === 'object' &&
        el !== null &&
        typeof (el as { message?: unknown }).message === 'string',
    )
  );
}

// An abort may surface as DOMException (browser + modern Node), a plain Error
// subclass with name='AbortError', or (rarely) a plain object with that name
// on less conformant runtimes. Match any non-null thing exposing the name.
function isAbortError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

// Retryable S3 PUT response statuses: 429 throttling, 503 slow-down, and any
// other 5xx (502/504 are common transients behind CloudFront/S3). 4xx other
// than 429 (403 signed-URL expiry, 400 SignatureDoesNotMatch, etc.) are
// configuration / authority issues — retrying just delays the real failure.
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

// fetch surfaces network failures (DNS, TLS, TCP reset, mid-body disconnect)
// as TypeError. Abort surfaces as a DOMException with name='AbortError', not
// a TypeError, so a plain instanceof check is sufficient — abort is filtered
// before reaching here by the dedicated isAbortError guard in the catch.
function isRetryableNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

// Full-jitter exponential backoff: delay = random(0, base * 2^attemptIndex).
// AWS SDK guidance for shared-throttling sources like S3 — keeps competing
// clients from synchronising their retries.
function fullJitterDelay(baseMs: number, attemptIndex: number): number {
  if (baseMs <= 0) return 0;
  const ceiling = baseMs * Math.pow(2, attemptIndex);
  return Math.floor(Math.random() * ceiling);
}

// Cancel a Response body so undici (Node 18+ fetch) releases the underlying
// connection promptly instead of waiting for GC. We swallow any error: the
// retry loop is about to re-PUT the chunk; failing the cleanup must not
// shadow the real failure that triggered the retry.
async function drainResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* ignore */
  }
}

// Reject NaN/Infinity and floor at 1 attempt. A misconfigured 0/negative
// still attempts the PUT once (so callers see the underlying error rather
// than a silent zero-PUT no-op).
function sanitiseAttempts(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

// Reject NaN/Infinity and clamp at 0. `0` is permitted so callers can opt out
// of backoff entirely (e.g. for fast-path tests); `Infinity` would otherwise
// stall the retry loop indefinitely on the very first backoff.
function sanitiseBaseMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

// Cancellable sleep. Resolves after `ms` ms, rejects with GislAbortError if
// the caller's signal aborts, or resolves early (without throwing) if the
// internal `wakeSignal` fires — that path lets a sibling worker's terminal
// failure short-circuit a peer's backoff sleep without producing a spurious
// abort error in the peer's own throw stack.
function sleepWithEitherSignal(
  ms: number,
  abortSignal: AbortSignal | undefined,
  wakeSignal: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) {
    return Promise.reject(new GislAbortError('Multipart upload aborted'));
  }
  if (wakeSignal.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      abortSignal?.removeEventListener('abort', onAbort);
      wakeSignal.removeEventListener('abort', onWake);
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new GislAbortError('Multipart upload aborted'));
    };
    const onWake = (): void => {
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
function bindAbortSignal(
  external: AbortSignal | undefined,
  internal: AbortController,
  onExternalAbort?: () => void,
): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    onExternalAbort?.();
    internal.abort();
    return () => {};
  }
  const onAbort = (): void => {
    onExternalAbort?.();
    internal.abort();
  };
  external.addEventListener('abort', onAbort, { once: true });
  return () => external.removeEventListener('abort', onAbort);
}

export class GislClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly multipartThreshold: number;
  private readonly multipartConcurrency: number;
  private readonly multipartMaxAttempts: number;
  private readonly multipartRetryBaseMs: number;

  constructor(config: GislClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;
    // Floor the threshold at the first-chunk size: the multipart initiate
    // must always carry an 8MB chunk, so routing a sub-8MB file into the
    // multipart path would violate the contract.
    this.multipartThreshold = Math.max(
      config.multipartThreshold ?? SINGLE_SHOT_MAX_BYTES,
      DEFAULT_MULTIPART_FIRST_CHUNK_SIZE,
    );
    this.multipartConcurrency = config.multipartConcurrency ?? MULTIPART_CONCURRENCY_DEFAULT;
    // Sanitise: reject NaN/Infinity (the former would cause `attempt < NaN`
    // to be perpetually false, skipping every PUT; the latter would retry
    // unboundedly). Floor at 1 so a misconfigured 0/negative still attempts
    // once.
    this.multipartMaxAttempts = sanitiseAttempts(
      config.multipartMaxAttempts,
      DEFAULT_MULTIPART_MAX_ATTEMPTS,
    );
    this.multipartRetryBaseMs = sanitiseBaseMs(
      config.multipartRetryBaseMs,
      DEFAULT_MULTIPART_RETRY_BASE_MS,
    );

    this.headers = { ...config.headers };
    if (config.apiKey) {
      this.headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
  }

  // -----------------------------------------------------------------------
  // Internal HTTP
  // -----------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    opts: {
      body?: BodyInit | Record<string, unknown>;
      json?: boolean;
      deserialize?: (raw: unknown) => T;
      rawResponse?: boolean;
      signal?: AbortSignal;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    // Fast-fail on a pre-aborted user signal before building the request.
    if (opts.signal?.aborted) {
      throw new GislAbortError(`Request to ${method} ${path} aborted`);
    }

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { ...this.headers, ...opts.headers };
    let body: BodyInit | undefined;

    if (opts.json !== false && opts.body && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    } else {
      body = opts.body as BodyInit | undefined;
    }

    const controller = new AbortController();
    // Record the first cause that tripped the composed controller. Checking
    // `opts.signal.aborted` alone at catch time is not sound: if the timer
    // fires first and the user signal aborts microseconds later (before
    // `catch` runs), that flag is also true — but the true cause was the
    // timeout. Capturing which side fired first gives a deterministic
    // classification regardless of scheduling.
    let firstCause: 'timeout' | 'user' | null = null;
    const timer = setTimeout(() => {
      if (firstCause === null) firstCause = 'timeout';
      controller.abort();
    }, this.timeoutMs);
    const unbind = bindAbortSignal(opts.signal, controller, () => {
      if (firstCause === null) firstCause = 'user';
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (isAbortError(err)) {
        if (firstCause === 'user') {
          throw new GislAbortError(`Request to ${method} ${path} aborted`);
        }
        throw new GislTimeoutError(`Request to ${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      unbind();
    }

    if (opts.rawResponse) {
      return response as unknown as T;
    }

    // 204 No Content — contracted success status for endpoints that return
    // no body (e.g. POST /api/contact). Short-circuit before handleResponse
    // so an empty body never trips the JSON parser.
    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return this.handleResponse(response, path, opts.deserialize);
  }

  private async handleResponse<T>(
    response: Response,
    path: string,
    deserialize?: (raw: unknown) => T,
  ): Promise<T> {
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const isJsonContent = contentType.includes('application/json') || contentType.includes('+json');
    if (!isJsonContent) {
      if (!response.ok) {
        throw new GislApiError(response.status, 'Non-JSON response', path);
      }
      return undefined as unknown as T;
    }

    // Wire-side fields are snake_case (raw response.json() — never run through
    // FromJSON helpers here). The structured-error subclasses receive a typed
    // payload built via the per-envelope FromJSON helper, which handles the
    // snake_case -> camelCase conversion for nested fields.
    let json: {
      success?: boolean;
      data?: unknown;
      error?: string;
      details?: unknown;
      error_type?: string;
      message_key?: string;
      locale?: string;
      message_params?: Record<string, unknown>;
    };
    try {
      json = await response.json();
    } catch {
      throw new GislApiError(response.status, 'Invalid JSON response', path);
    }

    // Standard envelope: { success, data } or { success, error, details }
    if (!response.ok || json.success === false) {
      // Localisation triple per ticket I26 — surfaced on every typed error so
      // consumers can drive client-side i18n catalogs without unwrapping the
      // typed payload. Field names are wire snake_case here; the typed payload
      // (built via FromJSON below) carries camelCase copies.
      const i18n: GislApiErrorOptions = {
        messageKey: json.message_key,
        locale: json.locale,
        messageParams: json.message_params,
      };

      // Validation-details branch first — preserve existing shape so callers
      // matching on `instanceof GislValidationError` keep working.
      if (isValidationDetails(json.details)) {
        throw new GislValidationError(
          response.status,
          json.error ?? 'Validation error',
          json.details,
          path,
          i18n,
        );
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
      const status = response.status;
      const errorMessage = json.error ?? 'Unknown error';

      // Build the typed payload via FromJSON, then validate that all
      // required typed fields are well-formed. FromJSON does not throw on
      // missing required fields — for example `workflow_expired` without
      // `expired_at` produces `new Date(undefined)` => Invalid Date with
      // `getTime() === NaN`. Without an explicit validity check the error
      // would surface a silently-corrupted typed payload instead of falling
      // through to the generic base class.
      const tryThrowStructured = <T>(
        construct: (raw: unknown) => T,
        ErrorClass: new (
          status: number,
          msg: string,
          payload: T,
          path?: string,
          extra?: Omit<GislApiErrorOptions, 'payload'>,
        ) => GislApiError,
        validate?: (payload: T) => boolean,
      ): never | undefined => {
        let payload: T;
        try {
          payload = construct(json);
        } catch {
          return undefined;
        }
        if (validate && !validate(payload)) {
          return undefined;
        }
        throw new ErrorClass(status, errorMessage, payload, path, i18n);
      };

      const isValidDate = (d: unknown): d is Date =>
        d instanceof Date && !Number.isNaN(d.getTime());

      if (status === 401 || status === 403) {
        if (errorType && this.isAuthErrorType(errorType)) {
          tryThrowStructured(
            AuthErrorResponseFromJSON,
            GislAuthError,
            (p) => typeof p.errorType === 'string',
          );
        }
      }

      const isInEnum = (value: unknown, members: Readonly<Record<string, string>>): boolean =>
        typeof value === 'string' && Object.values(members).includes(value);

      const isFeatureViolation = (v: unknown): boolean =>
        typeof v === 'object' && v !== null
          && typeof (v as { feature?: unknown }).feature === 'string';

      if (status === 402 && errorType === 'balance_exhausted') {
        tryThrowStructured(
          BalanceExhaustedResponseFromJSON,
          GislBalanceExhaustedError,
          (p) => isInEnum(p.requiredAction, BalanceExhaustedResponseRequiredActionEnum),
        );
      }

      if (status === 403 && errorType === 'tier_restriction') {
        tryThrowStructured(
          TierRestrictionResponseFromJSON,
          GislTierRestrictedError,
          (p) => isInEnum(p.restrictionKind, TierRestrictionKind)
            && isInEnum(p.currentTier, UserTier),
        );
      }

      if (status === 403 && errorType === 'feature_tier_restricted') {
        tryThrowStructured(
          FeatureTierRestrictedResponseFromJSON,
          GislFeatureTierRestrictedError,
          (p) => Array.isArray(p.violations) && p.violations.every(isFeatureViolation),
        );
      }

      if (status === 422 && errorType === 'feature_not_available') {
        tryThrowStructured(
          FeatureNotAvailableResponseFromJSON,
          GislFeatureNotAvailableError,
          (p) => Array.isArray(p.violations) && p.violations.every(isFeatureViolation),
        );
      }

      if (status === 422 && errorType === 'workflow_expired') {
        tryThrowStructured(
          WorkflowExpiredResponseFromJSON,
          GislWorkflowExpiredError,
          (p) => isValidDate(p.expiredAt),
        );
      }

      throw new GislApiError(
        status,
        errorMessage,
        path,
        json.details,
        { ...i18n, payload: json },
      );
    }

    const data = json.data ?? json;
    return deserialize ? deserialize(data) : (data as T);
  }

  // Membership check for the AuthErrorType discriminator. Reads the generated
  // enum object directly so a future contract addition lands here without a
  // hand-edit. The bundle cost is one tiny `as const` literal map (8 entries).
  private isAuthErrorType(value: string): boolean {
    return Object.values(AuthErrorType).includes(value as AuthErrorType);
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
  async uploadFile(
    file: string | Blob,
    options?: UploadOptions,
  ): Promise<UploadResponse> {
    // Pre-abort check: bail before statSync/readFileSync buffers the whole
    // file into memory when the caller has already cancelled.
    if (options?.signal?.aborted) {
      throw new GislAbortError('Upload aborted before start');
    }

    let blob: Blob;
    let fileName: string;
    let fileSize: number;

    if (typeof file === 'string') {
      const stat = statSync(file);
      fileSize = stat.size;
      fileName = basename(file);
      const content = readFileSync(file);
      blob = new Blob([content]);
    } else {
      blob = file;
      fileName = (file as File).name ?? 'upload';
      fileSize = file.size;
    }

    if (fileSize > this.multipartThreshold) {
      return this.multipartUpload(blob, fileName, fileSize, options);
    }

    return this.singleUpload(blob, fileName, options);
  }

  private async singleUpload(
    blob: Blob,
    fileName: string,
    options?: UploadOptions,
  ): Promise<UploadResponse> {
    const form = new FormData();
    form.append('file', blob, fileName);

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
  private async multipartUpload(
    blob: Blob,
    fileName: string,
    totalSize: number,
    options?: UploadOptions,
  ): Promise<UploadResponse> {
    // Step 1: Initiate with first chunk
    const firstChunkSize = Math.min(totalSize, DEFAULT_MULTIPART_FIRST_CHUNK_SIZE);
    const firstChunk = blob.slice(0, firstChunkSize);

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
      initiateForm.append(
        'metadata_hint',
        JSON.stringify(MultipartInitiateRequestMetadataHintToJSON(options.metadataHint)),
      );
    }

    const initResponse = await this.request<MultipartInitiateResponse>(
      'POST',
      '/api/uploads/multipart/initiate',
      {
        body: initiateForm,
        json: false,
        deserialize: MultipartInitiateResponseFromJSON,
        signal: options?.signal,
      },
    );

    let uploadedBytes = firstChunkSize;
    options?.onProgress?.(uploadedBytes, totalSize);

    // Step 2: Upload remaining chunks to S3 presigned URLs
    const etags: Array<{ partNumber: number; etag: string }> = [];
    const presignedUrls = initResponse.presignedUrls;
    const chunkSize = initResponse.recommendedChunkSize;

    // Internal abort signal that workers use to short-circuit each others'
    // backoff sleeps. When any worker hits a terminal failure it aborts this
    // controller, which races the caller's signal inside sleepWithSignal so
    // sleeping siblings stop waiting for their timer to expire.
    const failureController = new AbortController();

    type FetchOutcome =
      | { kind: 'ok'; etag: string }
      | { kind: 'retryable'; lastErr: unknown }
      | { kind: 'fatal'; err: unknown };

    // Single PUT attempt. Returns a structured outcome instead of throwing
    // for retryable/non-retryable distinctions, so the caller can decide
    // whether to loop without conflating user-callback errors with
    // network-layer retries (codex review).
    const attemptPut = async (
      part: { partNumber: number; url: string },
      chunk: Blob,
      contentLength: number,
    ): Promise<FetchOutcome> => {
      let s3Response: Response;
      try {
        s3Response = await fetch(part.url, {
          method: 'PUT',
          body: chunk,
          headers: { 'Content-Length': contentLength.toString() },
          signal: options?.signal,
        });
      } catch (err: unknown) {
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
            err: new GislError(
              `S3 response missing ETag for part ${part.partNumber}`,
            ),
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
          err: new GislError(
            `S3 chunk upload failed for part ${part.partNumber}: ${s3Response.status}`,
          ),
        };
      }

      return {
        kind: 'retryable',
        lastErr: new GislError(
          `S3 chunk upload failed for part ${part.partNumber}: ${s3Response.status}`,
        ),
      };
    };

    const uploadChunk = async (index: number): Promise<void> => {
      const part = presignedUrls[index];
      const start = firstChunkSize + index * chunkSize;
      const end = Math.min(start + chunkSize, totalSize);
      // Blob.slice() returns a new Blob view; the underlying bytes are
      // immutable so the same `chunk` may be re-sent across retry attempts.
      // S3 multipart parts are idempotent by partNumber — a re-PUT overwrites,
      // there is no duplicate-data risk.
      const chunk = blob.slice(start, end);
      const contentLength = end - start;

      let lastErr: unknown = null;
      for (let attempt = 0; attempt < this.multipartMaxAttempts; attempt++) {
        if (options?.signal?.aborted) {
          throw new GislAbortError(`S3 part ${part.partNumber} upload aborted`);
        }
        if (failureController.signal.aborted) {
          // Sibling worker hit a terminal failure: bail before dispatching a
          // wasted PUT. The thrown error is swallowed by the outer worker
          // loop — Promise.all has already settled with the first failure.
          throw new GislError(
            `S3 part ${part.partNumber} upload abandoned after sibling worker failure`,
          );
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

        if (attempt + 1 >= this.multipartMaxAttempts) break;

        const delay = fullJitterDelay(this.multipartRetryBaseMs, attempt);
        // Race the caller's signal AND the sibling-failure signal so a
        // worker that fails terminally wakes its sleeping peers instead of
        // forcing them to wait out their backoff timer.
        await sleepWithEitherSignal(
          delay,
          options?.signal,
          failureController.signal,
        );
      }

      throw new GislError(
        `S3 chunk upload failed for part ${part.partNumber} after ${this.multipartMaxAttempts} attempts: ` +
          (lastErr instanceof Error ? lastErr.message : String(lastErr)),
      );
    };

    // Upload with concurrency limit. Workers check the signal before pulling
    // the next queue item so a mid-upload abort drains fast without
    // dispatching new chunks. Chunks already in-flight are cancelled via the
    // composed signal passed to fetch above; sleeping siblings are woken via
    // the failureController set below.
    const queue = [...presignedUrls.keys()];
    const workers = Array.from(
      { length: Math.min(this.multipartConcurrency, queue.length) },
      async () => {
        while (queue.length > 0 && !failureController.signal.aborted) {
          if (options?.signal?.aborted) {
            throw new GislAbortError('Multipart upload aborted');
          }
          const index = queue.shift()!;
          try {
            await uploadChunk(index);
          } catch (err) {
            // Wake any sibling currently in a backoff sleep, and prevent
            // siblings from picking up further queue items.
            failureController.abort();
            throw err;
          }
        }
      },
    );
    await Promise.all(workers);

    // Step 3: Complete multipart upload.
    // Build a typed MultipartCompleteRequest and serialise via the generated
    // ToJSON helper — tsc now catches any field-name drift between the SDK
    // and the OpenAPI spec (see contract-drift-fields.test.ts describe 'c').
    etags.sort((a, b) => a.partNumber - b.partNumber);

    const completeRequest: MultipartCompleteRequest = {
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
    const wireCompleteBody = MultipartCompleteRequestToJSON(completeRequest) as unknown as {
      upload_id: string;
      parts: Array<{ part_number: number; etag: string }>;
    };
    if (
      typeof wireCompleteBody?.upload_id !== 'string' ||
      !Array.isArray(wireCompleteBody?.parts)
    ) {
      throw new GislError(
        'MultipartCompleteRequestToJSON returned an unexpected shape — generator output may have changed.',
      );
    }

    const completeResp = await this.request<MultipartCompleteResponse>(
      'POST',
      '/api/uploads/multipart/complete',
      {
        body: wireCompleteBody as unknown as Record<string, unknown>,
        deserialize: MultipartCompleteResponseFromJSON,
        signal: options?.signal,
      },
    );

    // Defensive: the status enum currently has only 'completed', but guard
    // against future expansion so an unexpected terminal state doesn't pass
    // as a successful upload.
    if (completeResp.status !== 'completed') {
      throw new GislError(
        `Multipart upload completed with unexpected status: ${completeResp.status}`,
      );
    }

    return {
      fileId: completeResp.uploadId,
      originalName: fileName,
      mimeType: initResponse.mimeType,
      sizeBytes: blob.size,
      // Preserved from the initiate response: v2 contract makes
      // `constraintsApplied` a REQUIRED field on UploadResponse, and the
      // multipart/complete endpoint does not re-emit it. The first-chunk probe
      // result on the initiate envelope is the authoritative source.
      constraintsApplied: initResponse.constraintsApplied,
    };
  }

  // -----------------------------------------------------------------------
  // Workflows
  // -----------------------------------------------------------------------

  /**
   * Create a new workflow.
   */
  async createWorkflow(payload: WorkflowCreatePayload): Promise<WorkflowCreateResponse> {
    return this.request('POST', '/api/workflows', {
      body: payload as unknown as Record<string, unknown>,
      deserialize: WorkflowCreateResponseFromJSON,
    });
  }

  /**
   * Get current workflow status.
   */
  async getWorkflowStatus(workflowId: string): Promise<WorkflowStatusResponse> {
    return this.request('GET', `/api/workflows/${encodeURIComponent(workflowId)}/status`, {
      deserialize: WorkflowStatusResponseFromJSON,
    });
  }

  /**
   * Poll until the workflow reaches a terminal status.
   */
  async waitForWorkflow(
    workflowId: string,
    options?: WaitOptions,
  ): Promise<WorkflowStatusResponse> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const status = await this.getWorkflowStatus(workflowId);
      options?.onPoll?.(status.status);

      if (TERMINAL_STATUSES.has(status.status)) {
        return status;
      }

      if (Date.now() + intervalMs > deadline) {
        throw new GislTimeoutError(
          `Workflow ${workflowId} did not complete within ${timeoutMs}ms`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /**
   * Get download URLs for a completed workflow.
   */
  async getWorkflowDownloads(workflowId: string): Promise<WorkflowDownloadResponse> {
    return this.request('GET', `/api/workflows/${encodeURIComponent(workflowId)}/downloads`, {
      deserialize: WorkflowDownloadResponseFromJSON,
    });
  }

  /**
   * Stream SSE events for a workflow. Returns an async iterable.
   */
  async streamEvents(workflowId: string): Promise<AsyncGenerator<GislSseEvent>> {
    const eventsPath = `/api/workflows/${encodeURIComponent(workflowId)}/events`;
    const response = await this.request<Response>(
      'GET',
      eventsPath,
      { rawResponse: true },
    );

    if (!response.ok) {
      await this.handleResponse(response, eventsPath);
    }

    return parseSseStream(response);
  }

  // -----------------------------------------------------------------------
  // File metadata
  // -----------------------------------------------------------------------

  /**
   * Get metadata for an uploaded file.
   */
  async getMetadata(fileId: string): Promise<MetadataResponse> {
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
   */
  async getSchema(
    options: GetSchemaOptions = {},
  ): Promise<GetSchemaResult> {
    const params = new URLSearchParams();
    if (options.mimeType !== undefined) params.set('mime_type', options.mimeType);
    if (options.operation !== undefined) params.set('operation', options.operation);
    const query = params.toString();
    // The contract-drift test (tests/unit/contract-drift.test.ts) scans this
    // file for path literals via a regex that picks up both single-quoted
    // strings AND backtick templates. Embedding the querystring in a single
    // template would normalise to a path-with-querystring that no contract
    // path matches. Compose with concatenation so only the bare path appears
    // as a literal.
    const path = '/api/operations/schema' + (query ? '?' + query : '');

    const headers: Record<string, string> = {};
    if (options.ifNoneMatch !== undefined) headers['If-None-Match'] = options.ifNoneMatch;
    if (options.ifModifiedSince !== undefined) headers['If-Modified-Since'] = options.ifModifiedSince;

    const response = await this.request<Response>('GET', path, {
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
      try {
        const errJson = (await response.json()) as { error?: string };
        if (errJson.error) errorMessage = errJson.error;
      } catch {
        // Non-JSON body — keep generic message.
      }
      throw new GislApiError(response.status, errorMessage, path);
    }

    const raw: unknown = await response.json();
    const data = OperationsSchemaResponseFromJSON(raw);
    return { notModified: false, data, etag, lastModified };
  }

  /**
   * Retry a failed operation.
   */
  async retryOperation(operationId: string): Promise<RetryResponse> {
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
  async submitContact(payload: ContactRequest): Promise<void> {
    await this.request<void>('POST', '/api/contact', {
      body: payload as unknown as Record<string, unknown>,
    });
  }
}
