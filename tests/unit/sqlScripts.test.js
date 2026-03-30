import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("schema SQL define MailQueueAttachments", () => {
  const content = fs.readFileSync("sql/001_mailqueue_schema.sql", "utf8");
  assert.match(content, /CREATE TABLE dbo\.MailQueueAttachments/i);
  assert.match(content, /error_category/i);
  assert.match(content, /lock_token/i);
});

test("interceptor SQL redefine sp_send_dbmail", () => {
  const content = fs.readFileSync("sql/002_intercept_sp_send_dbmail.sql", "utf8");
  assert.match(content, /CREATE OR ALTER PROCEDURE dbo\.sp_send_dbmail/i);
  assert.match(content, /INSERT INTO MailDB\.dbo\.MailQueue/i);
});
