import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

export async function sendMail(mail) {
  return transporter.sendMail({
    from: process.env.SMTP_USER,
    to: mail.to_email,
    subject: mail.subject,
    html: mail.body
  });
}