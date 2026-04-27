import type {
  AuthErrorResponse,
  BalanceExhaustedResponse,
  FeatureNotAvailableResponse,
  FeatureTierRestrictedResponse,
  TierRestrictionResponse,
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
