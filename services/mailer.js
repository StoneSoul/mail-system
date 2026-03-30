import fs from "fs/promises";
import nodemailer from "nodemailer";
import { resolveCandidateAccounts } from "../config/senderProfiles.js";

const transportCache = new Map();

function getTransport(account) {
  if (!transportCache.has(account.key)) {
    transportCache.set(
      account.key,
      nodemailer.createTransport({
        host: account.host,
        port: account.port,
        secure: account.secure,
        auth: account.auth
      })
    );
  }

  return transportCache.get(account.key);
}

function normalizeAddressList(value) {
  if (!value) return undefined;
  const raw = String(value)
    .split(/[;,]+/)
    .map(item => item.trim())
    .filter(Boolean);

  return raw.length ? raw.join(", ") : undefined;
}

function normalizeLegacyPathAttachments(value) {
  if (!value) return [];

  return String(value)
    .split(";")
    .map(item => item.trim())
    .filter(Boolean)
    .map(filePath => ({ path: filePath }));
}

async function normalizeDbAttachments(attachments) {
  const normalized = [];

  for (const attachment of attachments || []) {
    if (attachment?.file_content) {
      normalized.push({
        filename: attachment.file_name || "adjunto.bin",
        contentType: attachment.content_type || undefined,
        content: Buffer.from(attachment.file_content)
      });
      continue;
    }

    if (attachment?.file_path) {
      const content = await fs.readFile(attachment.file_path);
      normalized.push({
        filename: attachment.file_name || attachment.file_path.split(/[\\/]/).pop() || "adjunto.bin",
        contentType: attachment.content_type || undefined,
        content
      });
    }
  }

  return normalized;
}

function buildMailPayload(mail, account, attachments) {
  const to = normalizeAddressList(mail.to_email || mail.recipients);
  const cc = normalizeAddressList(mail.copy_recipients || mail.cc);
  const bcc = normalizeAddressList(mail.blind_copy_recipients || mail.bcc);
  const body = mail.body || "";
  const bodyFormat = String(mail.body_format || "HTML").toUpperCase();

  return {
    from: mail.from_address || account.fromEmail,
    to,
    cc,
    bcc,
    replyTo: normalizeAddressList(mail.reply_to),
    subject: mail.subject,
    html: bodyFormat === "TEXT" ? undefined : body,
    text: bodyFormat === "TEXT" ? body : undefined,
    attachments
  };
}

export async function sendMail(mail, dbAttachments = [], classification = null) {
  const senderProfile = mail.sender_profile || mail.senderProfile || mail.MailProfile || "default";
  const allowFallback = Boolean(classification?.allowFallback);
  const candidates = resolveCandidateAccounts(senderProfile, allowFallback);
  const dbResolved = await normalizeDbAttachments(dbAttachments);
  const legacyResolved = normalizeLegacyPathAttachments(mail.file_attachments || mail.attachments);
  const mergedAttachments = [...dbResolved, ...legacyResolved];

  let lastError = null;
  for (const account of candidates) {
    try {
      const transporter = getTransport(account);
      const info = await transporter.sendMail(buildMailPayload(mail, account, mergedAttachments));
      return { info, accountKey: account.key };
    } catch (err) {
      lastError = err;
      if (!allowFallback) break;
    }
  }

  throw lastError || new Error("No se pudo enviar el correo");
}
