import dotenv from "dotenv";
import { query } from "../services/db.js";
import { mailQueue } from "../queue/mailQueue.js";
import { col, pendingStateTokens, resolveMailQueueColumns, semanticStatusToken } from "../utils/mailQueueColumns.js";

dotenv.config();

const POLL_MS = Number(process.env.DISPATCHER_POLL_MS || 5000);
const BATCH_SIZE = Number(process.env.DISPATCHER_BATCH_SIZE || 20);

let isDispatching = false;

function escapeSqlString(value) {
  return String(value || "").replace(/'/g, "''");
}

async function claimPendingMails() {
  const columns = await resolveMailQueueColumns();

  if (!columns.id || !columns.status) {
    throw new Error("MailQueue no tiene columnas mínimas compatibles (id + estado).");
  }

  const idCol = col(columns.id);
  const statusCol = col(columns.status);
  const retriesCondition = columns.retries ? `AND ${col(columns.retries)} < 5` : "";
  const pendingStates = pendingStateTokens(columns).map(state => `'${escapeSqlString(state)}'`).join(", ");
  const processingToken = escapeSqlString(semanticStatusToken(columns, "processing"));

  const result = await query(`
    ;WITH next_mails AS (
      SELECT TOP (${BATCH_SIZE}) *
      FROM MailQueue WITH (READPAST, UPDLOCK, ROWLOCK)
      WHERE ${statusCol} IN (${pendingStates})
        ${retriesCondition}
      ORDER BY ${idCol} ASC
    )
    UPDATE next_mails
    SET ${statusCol}='${processingToken}'
    OUTPUT INSERTED.*;
  `);

  return result.recordset || [];
}

async function enqueueMail(mail, columns) {
  const idRaw = mail?.[columns.id] ?? mail?.id ?? mail?.mailitem_id;
  const id = Number(idRaw);

  try {
    await mailQueue.add("mail", mail, {
      jobId: Number.isFinite(id) ? `mail-${id}` : undefined
    });
  } catch (err) {
    if (columns.status && columns.id && Number.isFinite(id)) {
      const setParts = [`${col(columns.status)}='${escapeSqlString(semanticStatusToken(columns, "pending"))}'`];
      if (columns.error) {
        setParts.push(`${col(columns.error)}='${escapeSqlString(err.message)}'`);
      }

      await query(`
        UPDATE MailQueue
        SET ${setParts.join(", ")}
        WHERE ${col(columns.id)}=${id}
      `);
    }

    throw err;
  }
}

async function dispatchCycle() {
  if (isDispatching) return;
  isDispatching = true;

  try {
    const columns = await resolveMailQueueColumns();
    const mails = await claimPendingMails();

    if (mails.length === 0) return;

    console.log(`[dispatcher] ${mails.length} mail(s) reclamados de SQL para encolar`);

    for (const mail of mails) {
      await enqueueMail(mail, columns);
      const itemId = mail?.[columns.id] ?? mail?.id ?? mail?.mailitem_id ?? "?";
      console.log(`[dispatcher] Mail id=${itemId} encolado`);
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
