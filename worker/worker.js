import { Worker } from "bullmq";
import { sendMail } from "../services/mailer.js";
import { classifyError } from "../utils/errorClassifier.js";
import { query } from "../services/db.js";
import { sendTelegram } from "../alerts/telegram.js";
import { bullConnection, redisConfig } from "../config/redis.js";

const worker = new Worker(
  "mail-queue", // nombre de la cola
  async job => {
    const mail = job.data;
    const mailItemId = mail.mailitem_id;

    try {
      await sendMail(mail);

      await query(`
        UPDATE MailQueue
        SET sent_status='sent',
            sent_date=GETDATE(),
            last_error=NULL
        WHERE mailitem_id=${mailItemId}
      `);

    } catch (err) {
      const type = classifyError(err);
      const safeError = String(err.message || "Error desconocido").replace(/'/g, "''");

      await query(`
        UPDATE MailQueue
        SET sent_status = CASE WHEN retries + 1 >= 5 THEN 'failed' ELSE 'unsent' END,
            last_error='${safeError}',
            retries = retries + 1,
            processed_by='node-worker'
        WHERE mailitem_id=${mailItemId}
      `);

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
