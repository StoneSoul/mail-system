import test from "node:test";
import assert from "node:assert/strict";
import { resolveRetryDecision } from "../../worker/retryPolicy.js";

test("retry permitido con TEMPORARY", () => {
  const decision = resolveRetryDecision({ retryable: true }, 1, 5);
  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.finalStatus, "PENDING");
  assert.ok(decision.nextRetryAt instanceof Date);
});

test("retry bloqueado por max retries", () => {
  const decision = resolveRetryDecision({ retryable: true }, 5, 5);
  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.finalStatus, "FAILED");
});
