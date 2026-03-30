export function resolveRetryDecision(classification, retries, maxRetries = 5) {
  const currentRetries = Number(retries || 0);
  const retryable = Boolean(classification?.retryable);
  const canRetry = retryable && currentRetries < maxRetries;

  if (!canRetry) {
    return {
      finalStatus: "FAILED",
      shouldRetry: false,
      nextRetryAt: null
    };
  }

  const delayMinutes = Math.min(60, Math.pow(2, currentRetries));
  const nextRetryAt = new Date(Date.now() + delayMinutes * 60 * 1000);

  return {
    finalStatus: "PENDING",
    shouldRetry: true,
    nextRetryAt
  };
}
