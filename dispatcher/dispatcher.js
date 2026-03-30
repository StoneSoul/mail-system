import dotenv from "dotenv";
import { query } from "../services/db.js";
import { mailQueue } from "../queue/mailQueue.js";

dotenv.config();

const POLL_MS = Number(process.env.DISPATCHER_POLL_MS || 5000);
const BATCH_SIZE = Number(process.env.DISPATCHER_BATCH_SIZE || 20);

let isDispatching = false;

async function claimPendingMails() {
  const result = await query(`
    ;WITH next_mails AS (
      SELECT TOP (${BATCH_SIZE}) *
      FROM MailQueue WITH (READPAST, UPDLOCK, ROWLOCK)
      WHERE sent_status IN ('unsent', 'retrying')
      ORDER BY mailitem_id ASC
    )
    UPDATE next_mails
    SET sent_status='retrying'
    OUTPUT INSERTED.*;
  `);

  return result.recordset || [];
}

async function enqueueMail(mail) {
  try {
    await mailQueue.add("mail", mail, {
      jobId: `mail-${mail.mailitem_id}`
    });
  } catch (err) {
    await query(`
      UPDATE MailQueue
      SET sent_status='unsent',
          last_error='${String(err.message).replace(/'/g, "''")}'
      WHERE mailitem_id=${mail.mailitem_id}
    `);

    throw err;
  }
}

async function dispatchCycle() {
  if (isDispatching) return;
  isDispatching = true;

  try {
    const mails = await claimPendingMails();

    if (mails.length === 0) return;

    console.log(`[dispatcher] ${mails.length} mail(s) reclamados de SQL para encolar`);

    for (const mail of mails) {
      await enqueueMail(mail);
      console.log(`[dispatcher] Mail mailitem_id=${mail.mailitem_id} encolado`);
    }
  } catch (err) {
    console.error("[dispatcher] Error en ciclo de despacho:", err.message);
  } finally {
    isDispatching = false;
  }
}

setInterval(dispatchCycle, POLL_MS);

console.log(`[dispatcher] iniciado. Poll=${POLL_MS}ms Batch=${BATCH_SIZE}`);
await dispatchCycle();
