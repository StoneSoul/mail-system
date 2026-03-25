import { Worker } from "bullmq";
import { sendMail } from "../services/mailer.js";
import { classifyError } from "../utils/errorClassifier.js";
import { query } from "../services/db.js";
import { sendTelegram } from "../alerts/telegram.js";
import { createRedisConnection, redisConfig } from "../config/redis.js";

const connection = createRedisConnection();

const worker = new Worker(
  "mail-queue", // nombre de la cola
  async job => {
    const mail = job.data;

    try {
      await sendMail(mail);

      await query(`
        UPDATE MailQueue
        SET status='Sent', last_attempt=GETDATE()
        WHERE id=${mail.id}
      `);

    } catch (err) {
      const type = classifyError(err);

      await query(`
        UPDATE MailQueue
        SET status='Failed',
            error_message='${err.message}',
            error_type='${type}',
            retries = retries + 1,
            last_attempt=GETDATE()
        WHERE id=${mail.id}
      `);

      await sendTelegram(`❌ Error mail ${mail.to_email}: ${err.message}`);

      if (type === "HARD") throw new Error("HARD_FAIL");

      throw err;
    }
  },
  { connection }
);

worker.on("ready", () => {
  console.log(`Worker listo y conectado a Redis/Memurai (${redisConfig.host}:${redisConfig.port})`);
});

worker.on("error", err => {
  console.error("Error del worker:", err.message);
});
