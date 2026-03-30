import { Worker } from "bullmq";
import { sendMail } from "../services/mailer.js";
import { classifyError } from "../utils/errorClassifier.js";
import { query } from "../services/db.js";
import { sendTelegram } from "../alerts/telegram.js";
import { bullConnection, redisConfig } from "../config/redis.js";
import { col, resolveMailQueueColumns, semanticStatusToken } from "../utils/mailQueueColumns.js";

function escapeSqlString(value) {
  return String(value || "").replace(/'/g, "''");
}

async function markAsSent(mail, columns) {
  const idRaw = mail?.[columns.id] ?? mail?.id ?? mail?.mailitem_id;
  const id = Number(idRaw);
  if (!Number.isFinite(id) || !columns.id || !columns.status) return;

  const setParts = [
    `${col(columns.status)}='${escapeSqlString(semanticStatusToken(columns, "sent"))}'`
  ];

  if (columns.lastAttempt) setParts.push(`${col(columns.lastAttempt)}=GETDATE()`);
  if (columns.error) setParts.push(`${col(columns.error)}=NULL`);

  await query(`
    UPDATE MailQueue
    SET ${setParts.join(", ")}
    WHERE ${col(columns.id)}=${id}
  `);
}

async function markAsError(mail, columns, errorMessage) {
  const idRaw = mail?.[columns.id] ?? mail?.id ?? mail?.mailitem_id;
  const id = Number(idRaw);
  if (!Number.isFinite(id) || !columns.id || !columns.status) return;

  const setParts = [];

  if (columns.retries) {
    setParts.push(`${col(columns.status)} = CASE WHEN ${col(columns.retries)} + 1 >= 5 THEN '${escapeSqlString(semanticStatusToken(columns, "failed"))}' ELSE '${escapeSqlString(semanticStatusToken(columns, "pending"))}' END`);
    setParts.push(`${col(columns.retries)} = ${col(columns.retries)} + 1`);
  } else {
    setParts.push(`${col(columns.status)}='${escapeSqlString(semanticStatusToken(columns, "failed"))}'`);
  }

  if (columns.error) setParts.push(`${col(columns.error)}='${escapeSqlString(errorMessage)}'`);
  if (columns.processedBy) setParts.push(`${col(columns.processedBy)}='node-worker'`);
  if (columns.lastAttempt) setParts.push(`${col(columns.lastAttempt)}=GETDATE()`);

  await query(`
    UPDATE MailQueue
    SET ${setParts.join(", ")}
    WHERE ${col(columns.id)}=${id}
  `);
}

const worker = new Worker(
  "mail-queue",
  async job => {
    const mail = job.data;
    const columns = await resolveMailQueueColumns();

    try {
      await sendMail(mail);
      await markAsSent(mail, columns);
    } catch (err) {
      const type = classifyError(err);
      await markAsError(mail, columns, err.message || "Error desconocido");
      await sendTelegram(`❌ Error mail ${mail.recipients || mail.to_email}: ${err.message}`);

      if (type === "HARD") throw new Error("HARD_FAIL");
      throw err;
    }
  },
  { connection: bullConnection }
);

worker.on("ready", () => {
  console.log(`Worker listo y conectado a Redis/Memurai (${redisConfig.host}:${redisConfig.port})`);
});

worker.on("error", err => {
  console.error("Error del worker:", err.message);
});
