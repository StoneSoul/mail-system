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

export async function sendMail(mail) {
  const requestedProfile = mail.sender_profile || mail.senderProfile || "default";
  const account = resolveSmtpAccount(requestedProfile);
  const transporter = getTransport(account);

  const to = mail.to_email || mail.recipients;
  const body = mail.body || "";
  const bodyFormat = String(mail.body_format || "HTML").toUpperCase();
  const textBody = bodyFormat === "TEXT" ? body : undefined;
  const htmlBody = bodyFormat === "TEXT" ? undefined : body;

  return transporter.sendMail({
    from: account.fromEmail,
    to,
    subject: mail.subject,
    html: htmlBody,
    text: textBody
  });
}
