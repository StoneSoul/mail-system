import { sqlQuery } from "../services/db.js";

let cachedColumns = null;

function asIdentifier(name) {
  return `[${String(name).replace(/]/g, "]]" )}]`;
}

function pickColumn(map, candidates) {
  for (const candidate of candidates) {
    const found = map.get(String(candidate).toLowerCase());
    if (found) return found;
  }
  return null;
}

export async function resolveMailQueueColumns() {
  if (cachedColumns) return cachedColumns;

  const rows = await sqlQuery(
    `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='MailQueue'`
  );

  const byLower = new Map(
    rows.map(row => {
      const original = String(row.COLUMN_NAME);
      return [original.toLowerCase(), original];
    })
  );

  const statusName = pickColumn(byLower, ["status", "estado", "sent_status"]);
  const statusRow = rows.find(row => String(row.COLUMN_NAME).toLowerCase() === String(statusName || "").toLowerCase());

  cachedColumns = {
    id: pickColumn(byLower, ["id", "mailitem_id"]),
    status: statusName,
    retries: pickColumn(byLower, ["retries", "retry_count", "reintentos"]),
    error: pickColumn(byLower, ["last_error", "error_message", "error", "error_msg", "mensaje_error"]),
    processedBy: pickColumn(byLower, ["processed_by", "worker", "processor"]),
    lastAttempt: pickColumn(byLower, ["last_attempt", "sent_date", "last_try", "updated_at", "fecha_ultimo_intento"]),
    to: pickColumn(byLower, ["to_email", "recipients", "to", "recipient", "correo", "destinatario"]),
    copyRecipients: pickColumn(byLower, ["copy_recipients", "cc", "cc_email"]),
    blindCopyRecipients: pickColumn(byLower, ["blind_copy_recipients", "bcc", "bcc_email"]),
    senderProfile: pickColumn(byLower, ["sender_profile", "mailprofile", "profile_name", "profile_id"]),
    sourceEnvironment: pickColumn(byLower, ["source_environment", "origin_environment", "source_env", "environment", "ambiente_origen"]),
    statusMaxLength: statusRow ? Number(statusRow.CHARACTER_MAXIMUM_LENGTH || 0) : null
  };

  return cachedColumns;
}

export function col(name) {
  return name ? asIdentifier(name) : null;
}

export function isSingleCharStatus(columns) {
  return Number(columns?.statusMaxLength) === 1;
}

export function semanticStatusToken(columns, semantic) {
  const singleChar = isSingleCharStatus(columns);
  const normalized = String(semantic || "").toLowerCase();

  if (normalized === "pending") return singleChar ? "P" : "Waiting";
  if (normalized === "processing") return singleChar ? "R" : "Processing";
  if (normalized === "sent") return singleChar ? "E" : "Sent";
  if (normalized === "failed") return singleChar ? "X" : "Failed";

  return String(semantic || "");
}

export function pendingStateTokens(columns) {
  if (isSingleCharStatus(columns)) {
    return ["P"];
  }

  return ["Waiting", "Pending", "unsent", "retrying", "P"];
}

export function clearMailQueueColumnsCache() {
  cachedColumns = null;
}

export async function fetchMailQueueColumnsFresh() {
  clearMailQueueColumnsCache();
  return resolveMailQueueColumns();
}
