import os from "os";
import { mailQueue } from "../queue/mailQueue.js";
import { claimPendingMails, recoverStuckProcessing } from "../repositories/mailQueueRepository.js";

const POLL_MS = Number(process.env.DISPATCHER_POLL_MS || 5000);
const BATCH_SIZE = Number(process.env.DISPATCHER_BATCH_SIZE || 50);
const LOCK_MINUTES = Number(process.env.MAIL_LOCK_MINUTES || 15);
const dispatcherId = `${os.hostname()}-${process.pid}`;

let isDispatching = false;

async function enqueueMail(mail) {
  const mailId = Number(mail?.id);
  if (!Number.isFinite(mailId)) {
    throw new Error("MailQueue.id inválido al encolar");
  }

  await mailQueue.add("mail", mail, {
    jobId: `mail-${mailId}`,
    removeOnComplete: 1000,
    removeOnFail: 1000
  });
}

async function dispatchCycle() {
  if (isDispatching) return;
  isDispatching = true;

  try {
    const recovered = await recoverStuckProcessing(LOCK_MINUTES);
    if (recovered > 0) {
      console.warn(`[dispatcher] recuperados ${recovered} mail(s) trabados`);
    }

    const mails = await claimPendingMails({
      batchSize: BATCH_SIZE,
      claimer: dispatcherId,
      lockMinutes: LOCK_MINUTES
    });

    if (!mails.length) return;

    for (const mail of mails) {
      await enqueueMail(mail);
      console.log(`[dispatcher] encolado mail id=${mail.id}`);
    }
  } catch (err) {
    console.error("[dispatcher] Error en ciclo:", err.message);
  } finally {
    isDispatching = false;
  }
}

setInterval(dispatchCycle, POLL_MS);
console.log(`[dispatcher] iniciado. Poll=${POLL_MS}ms Batch=${BATCH_SIZE} id=${dispatcherId}`);
await dispatchCycle();
