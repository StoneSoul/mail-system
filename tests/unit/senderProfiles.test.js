import test from "node:test";
import assert from "node:assert/strict";

function clearModuleCache() {
  return import(`../../config/senderProfiles.js?ts=${Date.now()}`);
}

test("carga cuenta default desde variables simples", async () => {
  process.env.SMTP_USER = "mailer@example.com";
  process.env.SMTP_PASS = "secret";
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_PORT = "465";
  process.env.SMTP_DEFAULT_ACCOUNT = "default";
  delete process.env.SMTP_ACCOUNTS_JSON;
  delete process.env.SENDER_PROFILE_MAP_JSON;

  const mod = await clearModuleCache();
  const account = mod.resolveSmtpAccount("default");

  assert.equal(account.host, "smtp.example.com");
  assert.equal(account.auth.user, "mailer@example.com");
});
