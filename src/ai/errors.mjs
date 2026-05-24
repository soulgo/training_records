export class AiProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AiProviderError';
    if (options.cause !== undefined) {
      this.cause = options.cause;
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
  }
}
