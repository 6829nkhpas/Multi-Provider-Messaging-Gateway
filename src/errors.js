export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ProviderError extends Error {
  constructor(message, { status, kind = 'provider', retryAfterMs, cause } = {}) {
    super(message, { cause });
    this.name = 'ProviderError';
    this.status = status;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}
