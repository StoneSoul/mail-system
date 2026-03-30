import nodemailer from "nodemailer";
import { resolveSmtpAccount } from "../config/senderProfiles.js";

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

  if (raw.length === 0) return undefined;
  return raw.join(", ");
}

function normalizeAttachments(value) {
  if (!value) return undefined;

  const paths = String(value)
    .split(";")
    .map(item => item.trim())
    .filter(Boolean);

  if (paths.length === 0) return undefined;
  return paths.map(filePath => ({ path: filePath }));
}

export async function sendMail(mail) {
  const requestedProfile = mail.sender_profile || mail.senderProfile || mail.MailProfile || "default";
  const account = resolveSmtpAccount(requestedProfile);
  const transporter = getTransport(account);

  const to = normalizeAddressList(mail.to_email || mail.recipients);
  const cc = normalizeAddressList(mail.copy_recipients || mail.cc);
  const bcc = normalizeAddressList(mail.blind_copy_recipients || mail.bcc);
  const body = mail.body || "";
  const bodyFormat = String(mail.body_format || "HTML").toUpperCase();
  const textBody = bodyFormat === "TEXT" ? body : undefined;
  const htmlBody = bodyFormat === "TEXT" ? undefined : body;

  return transporter.sendMail({
    from: mail.from_address || account.fromEmail,
    to,
    cc,
    bcc,
    replyTo: normalizeAddressList(mail.reply_to),
    subject: mail.subject,
    html: htmlBody,
    text: textBody,
    attachments: normalizeAttachments(mail.file_attachments || mail.attachments)
  });
}
