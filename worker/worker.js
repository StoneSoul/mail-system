import { Worker } from "bullmq";
import { sendMail } from "../services/mailer.js";
import { classifyError } from "../utils/errorClassifier.js";
import { getAttachments, markAsError, markAsSent } from "../repositories/mailQueueRepository.js";
import { resolveRetryDecision } from "./retryPolicy.js";
import { sendTelegram } from "../alerts/telegram.js";
import { bullConnection, redisConfig } from "../config/redis.js";

const MAX_RETRIES = Number(process.env.MAIL_MAX_RETRIES || 5);

const worker = new Worker(
  "mail-queue",
  async job => {
    const mail = job.data;

    try {
      const attachments = await getAttachments(mail.id);
      const result = await sendMail(mail, attachments);
      await markAsSent(mail.id, mail.lock_token, result.accountKey);
    } catch (err) {
      const classification = classifyError(err);
      const retryDecision = resolveRetryDecision(classification, mail.retries, MAX_RETRIES);

      await markAsError(mail, mail.lock_token, classification, retryDecision);
      await sendTelegram(`❌ Mail id=${mail.id} cat=${classification.category} detalle=${classification.detail}`);

      if (!retryDecision.shouldRetry) {
        return;
      }

      throw err;
    }
  },
  {
    connection: bullConnection,
    concurrency: Number(process.env.WORKER_CONCURRENCY || 5)
  }
);

worker.on("ready", () => {
  console.log(`Worker listo y conectado a Redis/Memurai (${redisConfig.host}:${redisConfig.port})`);
});

worker.on("error", err => {
  console.error("Error del worker:", err.message);
});
