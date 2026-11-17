'use strict';

class ProviderError extends Error {
  constructor(message, { code = null, retryable = true } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

module.exports = { ProviderError };
