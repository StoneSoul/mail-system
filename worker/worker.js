import { Worker } from "bullmq";
import { sendMail } from "../services/mailer.js";
import { classifyError } from "../utils/errorClassifier.js";
import { query } from "../services/db.js";
import { sendTelegram } from "../alerts/telegram.js";
import dotenv from "dotenv";

dotenv.config();

// Configuración de conexión a Redis/Memurai
const connection = {
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT),
};

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
  { connection } // <--- MUY IMPORTANTE
);

console.log("Worker running and connected to Redis/Memurai...");