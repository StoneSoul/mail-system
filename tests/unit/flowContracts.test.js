import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("dispatcher usa claim + recuperación", () => {
  const content = fs.readFileSync("dispatcher/dispatcher.js", "utf8");
  assert.match(content, /recoverStuckProcessing/);
  assert.match(content, /claimPendingMails/);
  assert.match(content, /jobId:\s*`mail-\$\{mailId\}`/);
});

test("worker resuelve adjuntos desde SQL", () => {
  const content = fs.readFileSync("worker/worker.js", "utf8");
  assert.match(content, /getAttachments/);
  assert.match(content, /markAsSent/);
  assert.match(content, /markAsError/);
});
