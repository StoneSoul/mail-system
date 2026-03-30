import { sqlQuery, sql } from "../services/db.js";

const STATUS = {
  pending: "PENDING",
  processing: "PROCESSING",
  sent: "SENT",
  failed: "FAILED"
};

export async function recoverStuckProcessing(lockTimeoutMinutes = 15) {
  const result = await sqlQuery(
    `
    UPDATE dbo.MailQueue
    SET status = @pending,
        last_error = CONCAT('Recover: lock expirado ', CONVERT(NVARCHAR(30), SYSUTCDATETIME(), 126)),
        lock_token = NULL,
        lock_expires_at = NULL,
        claimed_by = NULL
    WHERE status = @processing
      AND lock_expires_at IS NOT NULL
      AND lock_expires_at < SYSUTCDATETIME();
  `,
    [
      { name: "pending", type: sql.NVarChar(20), value: STATUS.pending },
      { name: "processing", type: sql.NVarChar(20), value: STATUS.processing },
      { name: "timeout", type: sql.Int, value: lockTimeoutMinutes }
    ]
  );

  return result.rowsAffected?.[0] || 0;
}

export async function claimPendingMails({ batchSize = 20, claimer = "dispatcher", lockMinutes = 15 }) {
  const result = await sqlQuery(
    `
    ;WITH cte AS (
      SELECT TOP (@batchSize) *
      FROM dbo.MailQueue WITH (READPAST, UPDLOCK, ROWLOCK)
      WHERE status = @pending
        AND (next_retry_at IS NULL OR next_retry_at <= SYSUTCDATETIME())
      ORDER BY id ASC
    )
    UPDATE cte
    SET status = @processing,
        claimed_by = @claimer,
        claimed_at = SYSUTCDATETIME(),
        lock_token = NEWID(),
        lock_expires_at = DATEADD(MINUTE, @lockMinutes, SYSUTCDATETIME())
    OUTPUT INSERTED.*;
    `,
    [
      { name: "batchSize", type: sql.Int, value: batchSize },
      { name: "pending", type: sql.NVarChar(20), value: STATUS.pending },
      { name: "processing", type: sql.NVarChar(20), value: STATUS.processing },
      { name: "claimer", type: sql.NVarChar(200), value: claimer },
      { name: "lockMinutes", type: sql.Int, value: lockMinutes }
    ]
  );

  return result.recordset || [];
}

export async function getAttachments(mailId) {
  const result = await sqlQuery(
    `
    SELECT
      id,
      mail_queue_id,
      file_name,
      content_type,
      file_content,
      file_path
    FROM dbo.MailQueueAttachments
    WHERE mail_queue_id = @mailId
    ORDER BY id ASC;
    `,
    [{ name: "mailId", type: sql.BigInt, value: Number(mailId) }]
  );

  return result.recordset || [];
}

export async function markAsSent(mailId, lockToken, accountKey) {
  await sqlQuery(
    `
    UPDATE dbo.MailQueue
    SET status = @sent,
        sent_at = SYSUTCDATETIME(),
        last_error = NULL,
        error_category = NULL,
        processed_account = @accountKey,
        lock_token = NULL,
        lock_expires_at = NULL,
        claimed_by = NULL,
        claimed_at = NULL
    WHERE id = @mailId
      AND lock_token = @lockToken;
    `,
    [
      { name: "sent", type: sql.NVarChar(20), value: STATUS.sent },
      { name: "accountKey", type: sql.NVarChar(100), value: accountKey || null },
      { name: "mailId", type: sql.BigInt, value: Number(mailId) },
      { name: "lockToken", type: sql.UniqueIdentifier, value: lockToken }
    ]
  );
}

export async function markAsError(mail, lockToken, classification, retryDecision) {
  await sqlQuery(
    `
    UPDATE dbo.MailQueue
    SET status = @status,
        retries = ISNULL(retries, 0) + 1,
        last_error = @detail,
        error_category = @category,
        next_retry_at = @nextRetryAt,
        last_attempt_at = SYSUTCDATETIME(),
        lock_token = NULL,
        lock_expires_at = NULL,
        claimed_by = NULL,
        claimed_at = NULL
    WHERE id = @mailId
      AND lock_token = @lockToken;
    `,
    [
      { name: "status", type: sql.NVarChar(20), value: retryDecision.finalStatus },
      { name: "detail", type: sql.NVarChar(sql.MAX), value: classification.detail || "Error desconocido" },
      { name: "category", type: sql.NVarChar(40), value: classification.category },
      { name: "nextRetryAt", type: sql.DateTime2, value: retryDecision.nextRetryAt || null },
      { name: "mailId", type: sql.BigInt, value: Number(mail.id) },
      { name: "lockToken", type: sql.UniqueIdentifier, value: lockToken }
    ]
  );
}
