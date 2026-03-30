import test from "node:test";
import assert from "node:assert/strict";
import { classifyError } from "../../utils/errorClassifier.js";

test("clasifica RATE_LIMIT_HOURLY", () => {
  const result = classifyError(new Error("451 4.7.0 rate limit exceeded"));
  assert.equal(result.category, "RATE_LIMIT_HOURLY");
  assert.equal(result.retryable, true);
});

test("clasifica MAILBOX_NOT_FOUND", () => {
  const result = classifyError(new Error("550 5.1.1 user unknown"));
  assert.equal(result.category, "MAILBOX_NOT_FOUND");
  assert.equal(result.retryable, false);
});
