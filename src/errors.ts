export class GislError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GislError';
  }
}

export class GislApiError extends GislError {
  readonly statusCode: number;
  readonly errorMessage: string;

  constructor(statusCode: number, errorMessage: string) {
    super(`API error ${statusCode}: ${errorMessage}`);
    this.name = 'GislApiError';
    this.statusCode = statusCode;
    this.errorMessage = errorMessage;
  }
}

export class GislValidationError extends GislApiError {
  readonly details: Array<{ field: string; message: string }>;

  constructor(
    statusCode: number,
    errorMessage: string,
    details: Array<{ field: string; message: string }>,
  ) {
    super(statusCode, errorMessage);
    this.name = 'GislValidationError';
    this.details = details;
  }
}

export class GislTimeoutError extends GislError {
  constructor(message: string) {
    super(message);
    this.name = 'GislTimeoutError';
  }
}
