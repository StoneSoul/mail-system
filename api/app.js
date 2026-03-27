import express from "express";
import sql from "mssql";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

import { mailQueue } from "../queue/mailQueue.js";
import { executeProcedure, getDbTargetsSummary, query, sqlQuery } from "../services/db.js";

import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

dotenv.config();

const app = express();
app.use(express.json());

// ------------------------
// Config panel + sesiones
// ------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const panelPath = path.resolve(__dirname, "../mvp/web/index.html");

function normalizeCredential(rawValue, fallback) {
  const source = rawValue ?? fallback;
  return String(source)
    .trim()
    .replace(/^["']/, "")
    .replace(/["']$/, "");
}

const PANEL_USER = normalizeCredential(process.env.PANEL_USER, "admin");
const PANEL_PASS = normalizeCredential(process.env.PANEL_PASS, "admin123");
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 horas
const SESSION_COOKIE = "mail_panel_session";
const sessions = new Map();

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map(chunk => chunk.trim())
      .filter(Boolean)
      .map(chunk => {
        const idx = chunk.indexOf("=");
        if (idx < 0) return [chunk, ""];
        return [chunk.slice(0, idx), decodeURIComponent(chunk.slice(idx + 1))];
      })
  );
}

function createSession(username) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionId, {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return sessionId;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;

  const data = sessions.get(sessionId);
  if (!data) return null;
  if (data.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return { sessionId, ...data };
}

function authMiddleware(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ ok: false, error: "No autorizado" });
  }
  req.session = session;
  next();
}

// ------------------------
// SQL helpers
// ------------------------

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
}

const PERMANENT_ERROR_CATEGORIES = ["MAILBOX_FULL", "MAILBOX_NOT_FOUND"];
const ALLOWED_ERROR_CATEGORIES = [
  "MAILBOX_FULL",
  "MAILBOX_NOT_FOUND",
  "SENDING_LIMIT",
  "TEMPORARY",
  "OTHER",
  "UNKNOWN"
];

const DEFAULT_PRODUCERS_BY_TARGET = {
  prod: [
    {
      procName: "SP_ENVIO_INFORMEPACIENTE_1",
      label: "Informe Paciente (Producción)",
      description: "Genera correos de informe para pacientes en entorno productivo."
    }
  ],
  test: [
    {
      procName: "SP_ENVIOMAILPERSONAL_PRUEBA",
      label: "Envío Personal (Prueba)",
      description: "SP de pruebas para validar envío controlado."
    }
  ],
  express: [
    {
      procName: "SP_MAILQUEUE_SEND",
      label: "Mail Queue Sender (SQL Express)",
      description: "SP del relay en SRV-EnviosMail para despachar cola."
    }
  ]
};

const DEFAULT_REMOTE_DATABASES_BY_TARGET = {
  prod: ["IMC", "IMC_DATOS"],
  test: ["IMC", "IMC_DATOS", "IMC_PRUEBA", "IMC_PRUEBAIT"],
  express: []
};

const REMOTE_DB_TARGETS = new Set(["prod", "test", "express"]);

function resolveRemoteTarget(rawTarget) {
  const aliases = {
    dttprod: "prod",
    produccion: "prod",
    production: "prod",
    dttprueba: "test",
    prueba: "test",
    testing: "test",
    qa: "test"
  };
  const normalized = aliases[String(rawTarget || "prod").toLowerCase()] || String(rawTarget || "prod").toLowerCase();
  if (!REMOTE_DB_TARGETS.has(normalized)) {
    throw new Error(`Target inválido: ${rawTarget}. Usá 'prod', 'test' o 'express'.`);
  }
  return normalized;
}

function parseProducerList(rawList, target) {
  const targetLabelByCode = {
    prod: "Producción",
    test: "Prueba",
    express: "SQL Express"
  };

  return String(rawList || "")
    .split(",")
    .map(proc => proc.trim())
    .filter(Boolean)
    .map(procName => ({
      procName,
      label: `${procName} (${targetLabelByCode[target] || target})`,
      description: `SP configurado para ${targetLabelByCode[target] || target}.`
    }));
}

function parseDatabaseList(rawList) {
  return String(rawList || "")
    .split(",")
    .map(db => db.trim())
    .filter(Boolean);
}

function sanitizeSqlIdentifier(identifier) {
  const value = String(identifier || "").trim();
  if (!value) return null;
  if (!/^[A-Za-z0-9_]+$/.test(value)) return null;
  return value;
}

function getRemoteDatabasesByTarget() {
  const prodFromEnv = parseDatabaseList(process.env.PROD_DB_CATALOG || process.env.PROD_DB_DATABASES);
  const testFromEnv = parseDatabaseList(process.env.TEST_DB_CATALOG || process.env.TEST_DB_DATABASES);
  const expressFromEnv = parseDatabaseList(process.env.EXPRESS_DB_CATALOG || process.env.EXPRESS_DB_DATABASES);

  return {
    prod: prodFromEnv.length ? prodFromEnv : DEFAULT_REMOTE_DATABASES_BY_TARGET.prod,
    test: testFromEnv.length ? testFromEnv : DEFAULT_REMOTE_DATABASES_BY_TARGET.test,
    express: expressFromEnv.length ? expressFromEnv : DEFAULT_REMOTE_DATABASES_BY_TARGET.express
  };
}

function getAvailableProducersByTarget() {
  const prodFromEnv = parseProducerList(process.env.PROD_SP_LIST, "prod");
  const testFromEnv = parseProducerList(process.env.TEST_SP_LIST, "test");
  const expressFromEnv = parseProducerList(process.env.EXPRESS_SP_LIST, "express");

  return {
    prod: prodFromEnv.length ? prodFromEnv : DEFAULT_PRODUCERS_BY_TARGET.prod,
    test: testFromEnv.length ? testFromEnv : DEFAULT_PRODUCERS_BY_TARGET.test,
    express: expressFromEnv.length ? expressFromEnv : DEFAULT_PRODUCERS_BY_TARGET.express
  };
}

function getAvailableProducers(target = null) {
  const byTarget = getAvailableProducersByTarget();
  if (target) {
    return byTarget[target] || [];
  }
  return [...byTarget.prod, ...byTarget.test, ...byTarget.express];
}

function normalizeProcName(procName = "") {
  return String(procName || "")
    .replace(/^\[?dbo\]?\./i, "")
    .replace(/^\[(.+)\]$/i, "$1")
    .trim();
}

async function fetchRemoteProducers(target) {
  const databasesByTarget = getRemoteDatabasesByTarget();
  const databaseList = (databasesByTarget[target] || []).map(sanitizeSqlIdentifier).filter(Boolean);
  if (!databaseList.length) return [];

  const allRows = [];
  for (const databaseName of databaseList) {
    const rows = await sqlQuery(
      `
        SELECT
          p.name AS procName,
          s.name AS schemaName
        FROM [${databaseName}].sys.procedures p
        INNER JOIN [${databaseName}].sys.schemas s ON s.schema_id = p.schema_id
        WHERE p.is_ms_shipped = 0
          AND s.name = 'dbo'
        ORDER BY p.name
      `,
      [],
      target
    );
    allRows.push(...rows.map(row => ({ ...row, sourceDb: databaseName })));
  }

  return allRows.map(row => {
    const procName = String(row.procName);
    const sourceDb = sanitizeSqlIdentifier(row.sourceDb);
    return {
      procName,
      sourceDb: sourceDb || null,
      label: `${procName} (${target.toUpperCase()} / ${sourceDb || "N/A"})`,
      description: `SP dbo detectado automáticamente en ${target} - ${sourceDb || "N/A"}.`
    };
  });
}

async function getAvailableProducersForTarget(target) {
  const configured = getAvailableProducers(target);
  let remote = [];

  try {
    remote = await fetchRemoteProducers(target);
  } catch (_err) {
    remote = [];
  }

  const merged = [...configured, ...remote];
  const unique = new Map();
  for (const producer of merged) {
    const normalizedProc = normalizeProcName(producer.procName);
    const normalizedSourceDb = sanitizeSqlIdentifier(producer.sourceDb) || "";
    const key = `${normalizedProc.toLowerCase()}::${normalizedSourceDb.toLowerCase()}`;
    if (!key) continue;
    if (!unique.has(key)) {
      unique.set(key, {
        ...producer,
        procName: normalizedProc,
        sourceDb: normalizedSourceDb || null
      });
    }
  }

  return Array.from(unique.values()).sort((a, b) => a.procName.localeCompare(b.procName));
}

async function remoteProcedureExists(target, procName) {
  const normalized = normalizeProcName(procName);
  if (!normalized) return false;

  const rows = await sqlQuery(
    `
      SELECT TOP 1 1 AS ok
      FROM sys.procedures p
      INNER JOIN sys.schemas s ON s.schema_id = p.schema_id
      WHERE p.is_ms_shipped = 0
        AND s.name = 'dbo'
        AND LOWER(p.name) = LOWER(@procName)
    `,
    [{ name: "procName", type: sql.NVarChar(128), value: normalized }],
    target
  );

  return rows.length > 0;
}

async function remoteProcedureExistsInDatabase(target, sourceDb, procName) {
  const normalized = normalizeProcName(procName);
  const databaseName = sanitizeSqlIdentifier(sourceDb);
  if (!normalized || !databaseName) return false;

  const rows = await sqlQuery(
    `
      SELECT TOP 1 1 AS ok
      FROM [${databaseName}].sys.procedures p
      INNER JOIN [${databaseName}].sys.schemas s ON s.schema_id = p.schema_id
      WHERE p.is_ms_shipped = 0
        AND s.name = 'dbo'
        AND LOWER(p.name) = LOWER(@procName)
    `,
    [{ name: "procName", type: sql.NVarChar(128), value: normalized }],
    target
  );

  return rows.length > 0;
}

const MAILDB_TABLES = [
  "spt_fallback_db",
  "spt_fallback_dev",
  "spt_fallback_usg",
  "IMCcorreos",
  "MailQueue",
  "MailAdminAudit",
  "spt_monitor",
  "MSreplication_options"
];

let cachedMailProfileExpression = null;
let cachedMailQueueColumns = null;

function asSqlIdentifier(columnName) {
  return `[${String(columnName).replace(/]/g, "]]")}]`;
}

async function resolveMailQueueColumns() {
  if (cachedMailQueueColumns) return cachedMailQueueColumns;

  const rows = await sqlQuery(`
    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME = 'MailQueue'
  `);

  const existingByLower = new Map(
    rows.map(row => {
      const original = String(row.COLUMN_NAME);
      return [original.toLowerCase(), original];
    })
  );

  function pick(candidates) {
    for (const candidate of candidates) {
      const matched = existingByLower.get(String(candidate).toLowerCase());
      if (matched) return asSqlIdentifier(matched);
    }
    return `CAST(NULL AS NVARCHAR(4000))`;
  }

  function pickForUpdate(candidates) {
    for (const candidate of candidates) {
      const matched = existingByLower.get(String(candidate).toLowerCase());
      if (matched) return asSqlIdentifier(matched);
    }
    return null;
  }

  const statusRow = rows.find(row => ["status", "estado"].includes(String(row.COLUMN_NAME).toLowerCase()));
  const statusColumn = pickForUpdate(["status", "estado"]);
  const retriesColumn = pickForUpdate(["retries", "retry_count", "reintentos"]);

  cachedMailQueueColumns = {
    toEmail: pick(["to_email", "to", "recipient", "email", "destinatario", "correo"]),
    subject: pick(["subject", "asunto", "title", "titulo"]),
    status: statusColumn ? statusColumn : "CAST(NULL AS NVARCHAR(20))",
    statusMaxLength: statusRow ? Number(statusRow.CHARACTER_MAXIMUM_LENGTH || 0) : null,
    retries: retriesColumn ? retriesColumn : "CAST(0 AS INT)",
    maxRetries: pick(["max_retries", "maxRetries", "tope_reintentos"]),
    errorMessage: pick(["error_message", "error", "error_msg", "mensaje_error", "errorMessage"]),
    createdAt: pick(["created_at", "createdon", "created_date", "fecha_creacion", "created"]),
    lastAttempt: pick(["last_attempt", "last_try", "ultimo_intento", "fecha_ultimo_intento", "updated_at"]),
    statusForWhere: statusColumn,
    retriesForUpdate: retriesColumn,
    errorMessageForUpdate: pickForUpdate(["error_message", "error", "error_msg", "mensaje_error", "errorMessage"]),
    errorTypeForUpdate: pickForUpdate(["error_type", "tipo_error", "error_kind"]),
    lastAttemptForUpdate: pickForUpdate(["last_attempt", "last_try", "ultimo_intento", "fecha_ultimo_intento", "updated_at"])
  };

  return cachedMailQueueColumns;
}

function isSingleCharStatus(columns) {
  return Number(columns?.statusMaxLength) === 1;
}

function statusTokens(columns, semanticStatus) {
  const normalized = String(semanticStatus || "").toLowerCase();
  const singleChar = isSingleCharStatus(columns);

  if (normalized === "failed") return singleChar ? ["X", "F"] : ["Failed"];
  if (normalized === "sent") return singleChar ? ["E", "S"] : ["Sent"];
  if (normalized === "processing") return singleChar ? ["R"] : ["Processing"];
  if (normalized === "pending" || normalized === "waiting") {
    return singleChar ? ["P"] : ["Waiting", "Pending"];
  }

  return [String(semanticStatus || "")];
}

function normalizeStatusExpression(statusExpression) {
  return `
  CASE
    WHEN ${statusExpression} IS NULL THEN 'Unknown'
    WHEN UPPER(CAST(${statusExpression} AS NVARCHAR(20))) IN ('P','PENDING','WAITING') THEN 'Pending'
    WHEN UPPER(CAST(${statusExpression} AS NVARCHAR(20))) IN ('R','PROCESSING') THEN 'Processing'
    WHEN UPPER(CAST(${statusExpression} AS NVARCHAR(20))) IN ('S','SENT','E') THEN 'Sent'
    WHEN UPPER(CAST(${statusExpression} AS NVARCHAR(20))) IN ('X','F','FAILED') THEN 'Failed'
    ELSE CAST(${statusExpression} AS NVARCHAR(20))
  END
`;
}

function buildStatusWhere(columns, status, paramPrefix = "status") {
  if (!status || !columns?.statusForWhere) {
    return { clause: "", inputs: [] };
  }

  const tokens = statusTokens(columns, status).filter(Boolean);
  if (tokens.length === 0) {
    return { clause: "", inputs: [] };
  }

  const inputs = tokens.map((token, index) => ({
    name: `${paramPrefix}${index}`,
    type: sql.NVarChar(20),
    value: token
  }));
  const placeholders = inputs.map(input => `@${input.name}`).join(", ");
  return {
    clause: `${columns.statusForWhere} IN (${placeholders})`,
    inputs
  };
}

function buildErrorCategorySql(errorMessageExpression) {
  return `
  CASE
    WHEN ${errorMessageExpression} IS NULL OR LTRIM(RTRIM(${errorMessageExpression})) = '' THEN 'UNKNOWN'
    WHEN LOWER(${errorMessageExpression}) LIKE '%mailbox full%' OR LOWER(${errorMessageExpression}) LIKE '%buzon lleno%' OR LOWER(${errorMessageExpression}) LIKE '%casilla llena%' THEN 'MAILBOX_FULL'
    WHEN LOWER(${errorMessageExpression}) LIKE '%user unknown%' OR LOWER(${errorMessageExpression}) LIKE '%mailbox unavailable%' OR LOWER(${errorMessageExpression}) LIKE '%no existe%' OR LOWER(${errorMessageExpression}) LIKE '%recipient address rejected%' THEN 'MAILBOX_NOT_FOUND'
    WHEN LOWER(${errorMessageExpression}) LIKE '%rate limit%' OR LOWER(${errorMessageExpression}) LIKE '%too many%' OR LOWER(${errorMessageExpression}) LIKE '%throttl%' OR LOWER(${errorMessageExpression}) LIKE '%se agoto%' OR LOWER(${errorMessageExpression}) LIKE '%quota%' THEN 'SENDING_LIMIT'
    WHEN LOWER(${errorMessageExpression}) LIKE '%timeout%' OR LOWER(${errorMessageExpression}) LIKE '%temporar%' OR LOWER(${errorMessageExpression}) LIKE '%connection%' OR LOWER(${errorMessageExpression}) LIKE '%try again%' THEN 'TEMPORARY'
    ELSE 'OTHER'
  END
`;
}

async function resolveMailProfileExpression() {
  if (cachedMailProfileExpression) return cachedMailProfileExpression;

  const columns = await sqlQuery(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME = 'MailQueue'
      AND COLUMN_NAME IN ('MailProfile', 'sender_profile')
  `);

  const namesByLower = new Map(
    columns.map(row => {
      const original = String(row.COLUMN_NAME);
      return [original.toLowerCase(), original];
    })
  );
  if (namesByLower.has("mailprofile")) {
    cachedMailProfileExpression = asSqlIdentifier(namesByLower.get("mailprofile"));
    return cachedMailProfileExpression;
  }
  if (namesByLower.has("sender_profile")) {
    cachedMailProfileExpression = `${asSqlIdentifier(namesByLower.get("sender_profile"))} AS MailProfile`;
    return cachedMailProfileExpression;
  }

  cachedMailProfileExpression = "CAST(NULL AS NVARCHAR(128)) AS MailProfile";
  return cachedMailProfileExpression;
}

// ------------------------
// Bull Board setup
// ------------------------
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");

createBullBoard({
  queues: [new BullMQAdapter(mailQueue)],
  serverAdapter
});

app.use("/admin/queues", authMiddleware, serverAdapter.getRouter());

// ------------------------
// Panel + auth simple
// ------------------------
app.get("/", (_req, res) => {
  res.sendFile(panelPath);
});

app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});

app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const normalizedUsername = String(username || "").trim();
  const normalizedPassword = String(password || "").trim();

  if (normalizedUsername !== PANEL_USER || normalizedPassword !== PANEL_PASS) {
    return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
  }

  const sessionId = createSession(normalizedUsername);
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const secureFlag = secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax${secureFlag}`);

  return res.json({ ok: true, user: normalizedUsername });
});

app.post("/auth/logout", authMiddleware, (req, res) => {
  sessions.delete(req.session.sessionId);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`);
  return res.json({ ok: true });
});

app.get("/auth/status", (req, res) => {
  const session = getSession(req);
  return res.json({ ok: true, loggedIn: Boolean(session), user: session?.username || null });
});

// ------------------------
// Endpoints API
// ------------------------
app.get("/health", (_req, res) => {
  res.send({
    ok: true,
    service: "mail-system-api",
    message: "Servicio operativo"
  });
});

app.post("/send", authMiddleware, async (req, res) => {
  const { to, subject, body, senderProfile } = req.body;

  const result = await query(`
    INSERT INTO MailQueue (to_email, subject, body)
    OUTPUT INSERTED.*
    VALUES ('${escapeSqlString(to)}', '${escapeSqlString(subject)}', '${escapeSqlString(body)}')
  `);

  const mail = result.recordset[0];
  await mailQueue.add("mail", { ...mail, senderProfile: senderProfile || "default" });

  res.send({ ok: true });
});

app.get("/mails", authMiddleware, async (_req, res) => {
  const result = await query("SELECT * FROM MailQueue ORDER BY id DESC");
  res.send(result.recordset);
});

app.post("/mails/retry/:id", authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).send({ error: "ID inválido" });
    }

    const queueColumns = await resolveMailQueueColumns();
    if (!queueColumns.statusForWhere) {
      return res.status(500).json({ error: "No se detectó una columna de estado compatible." });
    }

    const result = await query(`SELECT * FROM MailQueue WHERE id=${id}`);
    const mail = result.recordset[0];
    if (!mail) return res.status(404).send({ error: "Mail no encontrado" });

    const currentStatus = String(mail.status || mail.estado || "");
    if (currentStatus === "Sent") {
      return res.status(400).json({ error: "No se puede reintentar un mail ya enviado." });
    }

    const pendingToken = statusTokens(queueColumns, "Pending")[0] || "Waiting";
    const setClauses = [`${queueColumns.statusForWhere} = @pendingStatus`];
    if (queueColumns.errorMessageForUpdate) setClauses.push(`${queueColumns.errorMessageForUpdate} = NULL`);
    if (queueColumns.errorTypeForUpdate) setClauses.push(`${queueColumns.errorTypeForUpdate} = NULL`);
    if (queueColumns.lastAttemptForUpdate) setClauses.push(`${queueColumns.lastAttemptForUpdate} = NULL`);

    await sqlQuery(
      `UPDATE dbo.MailQueue
       SET ${setClauses.join(", ")}
       WHERE id = @id;`,
      [
        { name: "id", type: sql.Int, value: id },
        { name: "pendingStatus", type: sql.NVarChar(20), value: pendingToken }
      ]
    );

    const refreshed = await query(`SELECT * FROM MailQueue WHERE id=${id}`);
    const updatedMail = refreshed.recordset[0];
    await mailQueue.add("mail", { ...updatedMail, senderProfile: updatedMail.sender_profile || "default" });

    res.send({ ok: true, msg: "Mail reenviado a la cola" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/queue/delete", authMiddleware, async (req, res) => {
  try {
    const { ids, status, errorCategory } = req.body || {};
    const queueColumns = await resolveMailQueueColumns();
    const errorCategorySql = buildErrorCategorySql(queueColumns.errorMessage);
    const whereClauses = [];
    const inputs = [];

    if (Array.isArray(ids) && ids.length > 0) {
      const validIds = ids
        .map(x => Number(x))
        .filter(x => Number.isInteger(x) && x > 0);

      if (validIds.length === 0) {
        return res.status(400).json({ error: "No hay IDs válidos para eliminar." });
      }

      whereClauses.push(`id IN (${validIds.join(",")})`);
    } else {
      if (status && queueColumns.statusForWhere) {
        const statusWhere = buildStatusWhere(queueColumns, status, "deleteStatus");
        if (statusWhere.clause) {
          whereClauses.push(statusWhere.clause);
          inputs.push(...statusWhere.inputs);
        }
      }

      if (errorCategory && ALLOWED_ERROR_CATEGORIES.includes(errorCategory)) {
        whereClauses.push(`${errorCategorySql}=@errorCategory`);
        inputs.push({ name: "errorCategory", type: sql.NVarChar(50), value: errorCategory });
      }
    }

    if (whereClauses.length === 0) {
      return res.status(400).json({ error: "Debes indicar IDs o al menos un filtro de eliminación." });
    }

    await sqlQuery(
      `DELETE FROM dbo.MailQueue
       WHERE ${whereClauses.join(" AND ")};`,
      inputs
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------
// Endpoints Fullboard SQL-first (MVP)
// ------------------------
app.get("/api/metrics", authMiddleware, async (_req, res) => {
  try {
    let data;
    try {
      data = await sqlQuery("SELECT * FROM dbo.VW_MAILQUEUE_METRICS");
    } catch (err) {
      const missingView = String(err?.message || "").toLowerCase().includes("vw_mailqueue_metrics");
      if (!missingView) throw err;
      data = await sqlQuery(`
        SELECT
          SUM(CASE WHEN [status] IN (N'Waiting',N'P',N'Processing') THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN [status] = N'Sent' THEN 1 ELSE 0 END) AS sent,
          SUM(CASE WHEN [status] = N'Failed' THEN 1 ELSE 0 END) AS failed,
          COUNT(*) AS total
        FROM dbo.MailQueue
      `);
    }
    res.json(data[0] || {});
  } catch (e) {
    console.error("[/api/metrics] error", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/queue", authMiddleware, async (req, res) => {
  try {
    const status = req.query.status;
    const errorCategory = req.query.errorCategory;
    const queueColumns = await resolveMailQueueColumns();
    const errorCategorySql = buildErrorCategorySql(queueColumns.errorMessage);
    const inputs = [];
    const whereClauses = [];

    if (status && queueColumns.statusForWhere) {
      const statusWhere = buildStatusWhere(queueColumns, status);
      if (statusWhere.clause) {
        whereClauses.push(statusWhere.clause);
        inputs.push(...statusWhere.inputs);
      }
    }
    if (errorCategory && ALLOWED_ERROR_CATEGORIES.includes(errorCategory)) {
      whereClauses.push(`${errorCategorySql}=@errorCategory`);
      inputs.push({ name: "errorCategory", type: sql.NVarChar(50), value: errorCategory });
    }

    const where = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const mailProfileExpression = await resolveMailProfileExpression();

    const data = await sqlQuery(
      `SELECT TOP 200
         id,
         ${queueColumns.toEmail} AS to_email,
         ${queueColumns.subject} AS [subject],
         ${normalizeStatusExpression(queueColumns.status)} AS [status],
         ${queueColumns.status} AS [status_raw],
         ${queueColumns.retries} AS retries,
         ${queueColumns.maxRetries} AS max_retries,
         ${queueColumns.errorMessage} AS error_message,
         ${errorCategorySql} AS error_category,
         CASE WHEN ${errorCategorySql} IN ('MAILBOX_FULL', 'MAILBOX_NOT_FOUND') THEN 0 ELSE 1 END AS is_retryable,
         ${mailProfileExpression},
         ${queueColumns.createdAt} AS created_at,
         ${queueColumns.lastAttempt} AS last_attempt
       FROM dbo.MailQueue ${where}
       ORDER BY id DESC`,
      inputs
    );
    res.json(data);
  } catch (e) {
    console.error("[/api/queue] error", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/queue/columns", authMiddleware, async (_req, res) => {
  try {
    const queueColumns = await resolveMailQueueColumns();
    const mailProfileExpression = await resolveMailProfileExpression();
    res.json({
      ok: true,
      sourceTable: "dbo.MailQueue",
      mapping: {
        to_email: queueColumns.toEmail,
        subject: queueColumns.subject,
        status: queueColumns.status,
        retries: queueColumns.retries,
        max_retries: queueColumns.maxRetries,
        error_message: queueColumns.errorMessage,
        created_at: queueColumns.createdAt,
        last_attempt: queueColumns.lastAttempt,
        profile: mailProfileExpression
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/db/context", authMiddleware, (_req, res) => {
  res.json({
    ok: true,
    dbTargets: getDbTargetsSummary(),
    note: "La cola, mapeo y monitoreo salen de MailDB local (SQL Express)."
  });
});

app.get("/api/db/table-usage", authMiddleware, async (_req, res) => {
  try {
    const rows = await sqlQuery(`
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA='dbo'
      ORDER BY TABLE_NAME
    `);

    const usedByPanel = new Set(["MailQueue", "MailAdminAudit"]);
    const tableUsage = rows.map(row => {
      const tableName = String(row.TABLE_NAME);
      return {
        tableName,
        usedByPanel: usedByPanel.has(tableName),
        role:
          tableName === "MailQueue"
            ? "COLA_PRINCIPAL"
            : tableName === "MailAdminAudit"
              ? "AUDITORIA"
              : "NO_REFERENCIADA_POR_API"
      };
    });

    res.json({
      ok: true,
      queueSourceTable: "dbo.MailQueue",
      totalTables: tableUsage.length,
      tableUsage
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/db/tables", authMiddleware, async (_req, res) => {
  try {
    const rows = await sqlQuery(
      `SELECT TABLE_NAME
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA='dbo'
         AND TABLE_NAME IN (${MAILDB_TABLES.map((_, index) => `@table${index}`).join(",")})`,
      MAILDB_TABLES.map((table, index) => ({
        name: `table${index}`,
        type: sql.NVarChar(256),
        value: table
      }))
    );

    const existing = new Set(rows.map(row => String(row.TABLE_NAME).toLowerCase()));
    const tableStats = [];

    for (const tableName of MAILDB_TABLES) {
      const exists = existing.has(tableName.toLowerCase());
      let rowCount = null;
      if (exists) {
        const countRows = await sqlQuery(`SELECT COUNT(1) AS total FROM dbo.${asSqlIdentifier(tableName)}`);
        rowCount = Number(countRows[0]?.total || 0);
      }

      tableStats.push({
        tableName,
        exists,
        rowCount,
        role:
          tableName === "MailQueue"
            ? "COLA_PRINCIPAL"
            : tableName === "MailAdminAudit"
              ? "AUDITORIA"
              : "SISTEMA"
      });
    }

    res.json({
      ok: true,
      queueSourceTable: "dbo.MailQueue",
      producers: getAvailableProducers(),
      producersByTarget: getAvailableProducersByTarget(),
      tables: tableStats
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function getProducersHandler(req, res) {
  try {
    const target = req.query?.target ? resolveRemoteTarget(req.query.target) : null;
    const producersByTarget = {
      prod: await getAvailableProducersForTarget("prod"),
      test: await getAvailableProducersForTarget("test"),
      express: await getAvailableProducersForTarget("express")
    };

    res.json({
      ok: true,
      producers: target ? producersByTarget[target] : [...producersByTarget.prod, ...producersByTarget.test, ...producersByTarget.express],
      producersByTarget,
      availableDatabasesByTarget: getRemoteDatabasesByTarget()
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

app.get("/api/actions/producers", authMiddleware, getProducersHandler);
app.get("/actions/producers", authMiddleware, getProducersHandler);

app.post("/api/actions/run-sender", authMiddleware, async (req, res) => {
  try {
    const { maxItems = 100, user = "web", target = "prod" } = req.body || {};
    const remoteTarget = resolveRemoteTarget(target);
    await executeProcedure("dbo.SP_ADMIN_RUN_SENDER", [
      { name: "MaxItems", type: sql.Int, value: maxItems },
      { name: "ExecutedBy", type: sql.NVarChar(200), value: user }
    ], remoteTarget);
    res.json({ ok: true, target: remoteTarget });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/actions/requeue-failed", authMiddleware, async (req, res) => {
  try {
    const { user = "web", skipCategories = PERMANENT_ERROR_CATEGORIES } = req.body || {};
    const queueColumns = await resolveMailQueueColumns();
    const errorCategorySql = buildErrorCategorySql(queueColumns.errorMessage);
    const normalized = Array.isArray(skipCategories)
      ? skipCategories.filter(x => ALLOWED_ERROR_CATEGORIES.includes(x))
      : PERMANENT_ERROR_CATEGORIES;

    const notInClause = normalized.length
      ? `AND ${errorCategorySql} NOT IN (${normalized.map(x => `'${x}'`).join(",")})`
      : "";
    const failedTokens = statusTokens(queueColumns, "Failed");
    const pendingToken = statusTokens(queueColumns, "Pending")[0] || "Waiting";
    const failedInClause = failedTokens.map(token => `'${escapeSqlString(token)}'`).join(",");

    const setClauses = [];
    if (queueColumns.statusForWhere) setClauses.push(`${queueColumns.statusForWhere} = N'${escapeSqlString(pendingToken)}'`);
    if (queueColumns.retriesForUpdate) setClauses.push(`${queueColumns.retriesForUpdate} = 0`);
    if (queueColumns.errorMessageForUpdate) setClauses.push(`${queueColumns.errorMessageForUpdate} = NULL`);
    if (queueColumns.errorTypeForUpdate) setClauses.push(`${queueColumns.errorTypeForUpdate} = NULL`);
    if (queueColumns.lastAttemptForUpdate) setClauses.push(`${queueColumns.lastAttemptForUpdate} = NULL`);

    if (!queueColumns.statusForWhere || setClauses.length === 0) {
      return res.status(500).json({ error: "No se detectaron columnas compatibles para reencolar." });
    }

    const sqlText = `
      UPDATE dbo.MailQueue
      SET ${setClauses.join(",\n          ")}
      WHERE ${queueColumns.statusForWhere} IN (${failedInClause}) ${notInClause};
    `;

    await sqlQuery(sqlText);
    await sqlQuery(
      `INSERT INTO dbo.MailAdminAudit(Action, Params, ExecutedBy, Result)
       VALUES (N'REQUEUE_FAILED_FILTERED', @params, @user, N'OK')`,
      [
        { name: "params", type: sql.NVarChar(sql.MAX), value: `skipCategories=${normalized.join(",")}` },
        { name: "user", type: sql.NVarChar(200), value: user }
      ]
    );
    res.json({ ok: true, skipped: normalized });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/actions/run-producer", authMiddleware, async (req, res) => {
  try {
    const { procName, user = "web", target = "prod", sourceDb = null } = req.body || {};
    const remoteTarget = resolveRemoteTarget(target);
    const normalizedSourceDb = sanitizeSqlIdentifier(sourceDb);
    const normalizedProcName = normalizeProcName(procName);
    if (!normalizedProcName) {
      return res.status(400).json({ error: "Debes indicar procName." });
    }

    const exists = normalizedSourceDb
      ? await remoteProcedureExistsInDatabase(remoteTarget, normalizedSourceDb, normalizedProcName)
      : await remoteProcedureExists(remoteTarget, normalizedProcName);
    if (!exists) {
      const dbSuffix = normalizedSourceDb ? `/${normalizedSourceDb}` : "";
      return res.status(400).json({ error: `SP no encontrada en '${remoteTarget}${dbSuffix}': ${normalizedProcName}` });
    }

    if (normalizedSourceDb) {
      await sqlQuery(`EXEC [${normalizedSourceDb}].[dbo].[${normalizedProcName}]`, [], remoteTarget);
    } else {
      await executeProcedure("dbo.SP_ADMIN_RUN_PRODUCER", [
        { name: "ProcName", type: sql.NVarChar(128), value: normalizedProcName },
        { name: "ExecutedBy", type: sql.NVarChar(200), value: user }
      ], remoteTarget);
    }

    res.json({ ok: true, target: remoteTarget, procName: normalizedProcName, sourceDb: normalizedSourceDb });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/audit", authMiddleware, async (_req, res) => {
  try {
    const data = await sqlQuery("SELECT TOP 100 * FROM dbo.MailAdminAudit ORDER BY Id DESC");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------
// Start server
// ------------------------
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API running on port ${port}`));
