export class AiProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AiProviderError';
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.providerName !== undefined) {
      this.providerName = options.providerName;
    }
  }
}

export class AiSchemaError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AiSchemaError';
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options.schemaName !== undefined) {
      this.schemaName = options.schemaName;
    }
    if (options.schemaVersion !== undefined) {
      this.schemaVersion = options.schemaVersion;
    }
    if (options.path !== undefined) {
      this.path = options.path;
    }
    if (options.field !== undefined) {
      this.field = options.field;
    }
  }
}
