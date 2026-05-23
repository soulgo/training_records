export async function fetchWithRetry(url, init, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 350));
  const retryableStatuses = options.retryableStatuses ?? new Set();
  const logPrefix = options.logPrefix ?? '[http-retry]';
  const finalErrorMessage = options.finalErrorMessage ?? 'HTTP request failed';
  let lastResponse = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (response.ok || !retryableStatuses.has(response.status) || attempt === maxAttempts) {
        return response;
      }
      lastResponse = response;
      process.stderr.write(
        `${logPrefix} request failed with HTTP ${response.status}; retrying (${attempt}/${maxAttempts})\n`,
      );
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        throw error;
      }
      process.stderr.write(
        `${logPrefix} request failed: ${error instanceof Error ? error.message : String(error)}; retrying (${attempt}/${maxAttempts})\n`,
      );
    }

    await delay(baseDelayMs * attempt);
  }

  if (lastResponse) {
    return lastResponse;
  }
  throw lastError ?? new Error(finalErrorMessage);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
