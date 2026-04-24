export class GislError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GislError';
  }
}

export class GislApiError extends GislError {
  readonly statusCode: number;
  readonly errorMessage: string;
  readonly path?: string;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    errorMessage: string,
    path?: string,
    details?: unknown,
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
  }
}

export class GislValidationError extends GislApiError {
  // `declare` narrows the inherited `details: unknown` to the validation shape
  // without emitting a runtime field declaration. Emitting one under
  // ES2022 / useDefineForClassFields would run after super() and overwrite
  // the parent's assignment with `undefined`.
  declare readonly details: Array<{ field: string; message: string }>;

  constructor(
    statusCode: number,
    errorMessage: string,
    details: Array<{ field: string; message: string }>,
    path?: string,
  ) {
    super(statusCode, errorMessage, path, details);
    this.name = 'GislValidationError';
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
