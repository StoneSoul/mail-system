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
const remoteObjectsPath = path.resolve(__dirname, "../mvp/web/remote-objects.html");
const dbmailCallersPath = path.resolve(__dirname, "../mvp/web/dbmail-callers.html");
const mailDbInsightsPath = path.resolve(__dirname, "../mvp/web/maildb-insights.html");
const sqlMailMonitorPath = path.resolve(__dirname, "../mvp/web/sqlmail-monitor.html");

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
          s.name AS schemaName,
          CASE
            WHEN LOWER(p.name) LIKE '%mail%'
              OR LOWER(ISNULL(sm.definition, '')) LIKE '%sp_send_dbmail%'
              OR LOWER(ISNULL(sm.definition, '')) LIKE '%sysmail_%'
              OR LOWER(ISNULL(sm.definition, '')) LIKE '%mailqueue%'
              OR LOWER(ISNULL(sm.definition, '')) LIKE '%@recipients%'
              OR LOWER(ISNULL(sm.definition, '')) LIKE '%@copy_recipients%'
              OR LOWER(ISNULL(sm.definition, '')) LIKE '%@blind_copy_recipients%'
            THEN 1
            ELSE 0
          END AS isMailRelated
        FROM [${databaseName}].sys.procedures p
        INNER JOIN [${databaseName}].sys.schemas s ON s.schema_id = p.schema_id
        LEFT JOIN [${databaseName}].sys.sql_modules sm ON sm.object_id = p.object_id
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
      description: `SP dbo detectado automáticamente en ${target} - ${sourceDb || "N/A"}.`,
      isMailRelated: Number(row.isMailRelated) === 1
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
      continue;
    }

    const existing = unique.get(key);
    if (existing && producer?.isMailRelated === true) {
      existing.isMailRelated = true;
      unique.set(key, existing);
    }
  }

  return Array.from(unique.values()).sort((a, b) => a.procName.localeCompare(b.procName));
}

function shouldShowProducerByDefault(producer) {
  if (typeof producer?.isMailRelated === "boolean") {
    return producer.isMailRelated;
  }
  return true;
}

async function ensureRemoteVisibilityTable() {
  await sqlQuery(`
    IF OBJECT_ID(N'dbo.MailRemoteProcedureVisibility', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.MailRemoteProcedureVisibility (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Target NVARCHAR(20) NOT NULL,
        SourceDb NVARCHAR(128) NULL,
        ProcName NVARCHAR(128) NOT NULL,
        IsVisible BIT NOT NULL CONSTRAINT DF_MailRemoteProcedureVisibility_IsVisible DEFAULT (1),
        UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_MailRemoteProcedureVisibility_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        UpdatedBy NVARCHAR(200) NULL
      );
      CREATE UNIQUE INDEX UX_MailRemoteProcedureVisibility
        ON dbo.MailRemoteProcedureVisibility(Target, SourceDb, ProcName);
    END
  `);
}

async function getVisibilityRowsForTarget(target) {
  await ensureRemoteVisibilityTable();
  return sqlQuery(
    `
      SELECT Target, SourceDb, ProcName, IsVisible
      FROM dbo.MailRemoteProcedureVisibility
      WHERE Target = @target
    `,
    [{ name: "target", type: sql.NVarChar(20), value: target }]
  );
}

function visibilityKey(target, sourceDb, procName) {
  const db = sanitizeSqlIdentifier(sourceDb) || "";
  const proc = normalizeProcName(procName);
  return `${target.toLowerCase()}::${db.toLowerCase()}::${proc.toLowerCase()}`;
}

async function applyVisibilityFilter(target, producers) {
  const visibilityRows = await getVisibilityRowsForTarget(target);
  if (!visibilityRows.length) return producers.filter(shouldShowProducerByDefault);

  const rules = new Map();
  for (const row of visibilityRows) {
    const key = visibilityKey(row.Target, row.SourceDb, row.ProcName);
    rules.set(key, Number(row.IsVisible) === 1);
  }

  return producers.filter(producer => {
    const key = visibilityKey(target, producer.sourceDb, producer.procName);
    if (!rules.has(key)) return shouldShowProducerByDefault(producer);
    return rules.get(key);
  });
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

app.get("/remote-objects", authMiddleware, (_req, res) => {
  res.sendFile(remoteObjectsPath);
});

app.get("/dbmail-callers", authMiddleware, (_req, res) => {
  res.sendFile(dbmailCallersPath);
});

app.get("/maildb-insights", authMiddleware, (_req, res) => {
  res.sendFile(mailDbInsightsPath);
});

app.get("/sqlmail-monitor", authMiddleware, (_req, res) => {
  res.sendFile(sqlMailMonitorPath);
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
  const dbTargets = getDbTargetsSummary();
  const remoteDatabases = getRemoteDatabasesByTarget();

  res.json({
    ok: true,
    dbTargets,
    topology: {
      relay: {
        server: dbTargets.local.server,
        database: dbTargets.local.database,
        role: "SQL Express en el mismo servidor del servicio (sin archivos .mdf locales en el proyecto)."
      },
      remoteReadTargets: {
        prod: {
          server: dbTargets.prod.server,
          databases: remoteDatabases.prod
        },
        test: {
          server: dbTargets.test.server,
          databases: remoteDatabases.test
        }
      }
    },
    note: "La cola, mapeo y monitoreo salen de MailDB en SQL Express; los SP dbo se consultan en catálogos remotos configurados por entorno."
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
      prod: await applyVisibilityFilter("prod", await getAvailableProducersForTarget("prod")),
      test: await applyVisibilityFilter("test", await getAvailableProducersForTarget("test")),
      express: await applyVisibilityFilter("express", await getAvailableProducersForTarget("express"))
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

app.get("/api/db/remote-objects", authMiddleware, async (req, res) => {
  try {
    const target = resolveRemoteTarget(req.query?.target || "prod");
    const producers = await getAvailableProducersForTarget(target);
    const visibilityRows = await getVisibilityRowsForTarget(target);
    const visibilityMap = new Map();
    for (const row of visibilityRows) {
      visibilityMap.set(visibilityKey(target, row.SourceDb, row.ProcName), Number(row.IsVisible) === 1);
    }

    const groupedByDatabase = {};
    for (const producer of producers) {
      const sourceDb = sanitizeSqlIdentifier(producer.sourceDb) || "(sin_base)";
      if (!groupedByDatabase[sourceDb]) groupedByDatabase[sourceDb] = [];
      const key = visibilityKey(target, sourceDb, producer.procName);
      groupedByDatabase[sourceDb].push({
        procName: producer.procName,
        sourceDb,
        label: producer.label,
        description: producer.description,
        visibleInFullboard: visibilityMap.has(key) ? visibilityMap.get(key) : shouldShowProducerByDefault(producer)
      });
    }

    Object.keys(groupedByDatabase).forEach(db => {
      groupedByDatabase[db].sort((a, b) => a.procName.localeCompare(b.procName));
    });

    res.json({
      ok: true,
      target,
      availableDatabases: Object.keys(groupedByDatabase).sort((a, b) => a.localeCompare(b)),
      objectsByDatabase: groupedByDatabase
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function fetchDbMailCallersByTarget(target) {
  const databasesByTarget = getRemoteDatabasesByTarget();
  const databaseList = (databasesByTarget[target] || [])
    .map(sanitizeSqlIdentifier)
    .filter(Boolean);
  const findings = [];
  const errors = [];

  for (const databaseName of databaseList) {
    try {
      const rows = await sqlQuery(
        `
          SELECT
            s.name AS schemaName,
            o.name AS objectName,
            o.type AS objectTypeCode,
            o.type_desc AS objectType,
            CASE
              WHEN sm.definition LIKE '%sp_send_dbmail%' THEN 1
              ELSE 0
            END AS usesDbMail,
            CASE
              WHEN sm.definition LIKE '%sp_send_dbmail%' THEN SUBSTRING(sm.definition, CHARINDEX('sp_send_dbmail', sm.definition), 320)
              ELSE NULL
            END AS snippet
          FROM [${databaseName}].sys.sql_modules sm
          INNER JOIN [${databaseName}].sys.objects o ON sm.object_id = o.object_id
          INNER JOIN [${databaseName}].sys.schemas s ON o.schema_id = s.schema_id
          WHERE sm.definition LIKE '%sp_send_dbmail%'
          ORDER BY s.name, o.name
        `,
        [],
        target
      );

      for (const row of rows) {
        findings.push({
          target,
          database: databaseName,
          schema: String(row.schemaName || ""),
          objectName: String(row.objectName || ""),
          objectType: String(row.objectType || row.objectTypeCode || ""),
          usesDbMail: Number(row.usesDbMail) === 1,
          snippet: String(row.snippet || "").replace(/\s+/g, " ").trim()
        });
      }
    } catch (error) {
      errors.push({
        target,
        database: databaseName,
        error: error?.message || "Error desconocido consultando catálogo remoto."
      });
    }
  }

  return { findings, errors };
}

function normalizeMailSentStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "sent") return "sent";
  if (normalized === "failed") return "failed";
  if (normalized === "retrying") return "retrying";
  if (normalized === "unsent") return "unsent";
  return "other";
}

async function fetchSqlMailActivityByTarget(target, { statusFilter, top }) {
  const statusClause = statusFilter ? "AND ai.sent_status = @statusFilter" : "";
  const optionalColumnsRows = await sqlQuery(
    `
      SELECT
        MAX(CASE WHEN c.name = 'reply_to' THEN 1 ELSE 0 END) AS has_reply_to,
        MAX(CASE WHEN c.name = 'from_address' THEN 1 ELSE 0 END) AS has_from_address,
        MAX(CASE WHEN c.name = 'send_request_user' THEN 1 ELSE 0 END) AS has_send_request_user
      FROM msdb.sys.columns c
      WHERE c.object_id = OBJECT_ID('msdb.dbo.sysmail_allitems')
        AND c.name IN ('reply_to', 'from_address', 'send_request_user')
    `,
    [],
    target
  );
  const hasReplyToColumn = Boolean(optionalColumnsRows?.[0]?.has_reply_to);
  const hasFromAddressColumn = Boolean(optionalColumnsRows?.[0]?.has_from_address);
  const hasSendRequestUserColumn = Boolean(optionalColumnsRows?.[0]?.has_send_request_user);
  const replyToSelectClause = hasReplyToColumn
    ? "ai.reply_to"
    : "CAST(NULL AS NVARCHAR(320)) AS reply_to";
  const fromAddressSelectClause = hasFromAddressColumn
    ? "ai.from_address"
    : "CAST(NULL AS NVARCHAR(320)) AS from_address";
  const sendRequestUserSelectClause = hasSendRequestUserColumn
    ? "ai.send_request_user"
    : "CAST(NULL AS NVARCHAR(320)) AS send_request_user";

  const rows = await sqlQuery(
    `
      SELECT TOP (${top})
        ai.mailitem_id,
        ai.profile_id,
        ai.recipients,
        ai.copy_recipients,
        ai.blind_copy_recipients,
        ai.[subject],
        ai.body_format,
        ai.sent_status,
        ${fromAddressSelectClause},
        ${replyToSelectClause},
        ${sendRequestUserSelectClause},
        ai.importance,
        ai.send_request_date,
        ai.sent_date,
        ai.last_mod_date,
        sp.name AS profile_name,
        proc.last_process_id,
        ISNULL(evt.last_error, '') AS last_error
      FROM msdb.dbo.sysmail_allitems ai
      LEFT JOIN msdb.dbo.sysmail_profile sp ON ai.profile_id = sp.profile_id
      LEFT JOIN (
        SELECT
          el.mailitem_id,
          MAX(el.process_id) AS last_process_id
        FROM msdb.dbo.sysmail_event_log el
        WHERE el.process_id IS NOT NULL
        GROUP BY el.mailitem_id
      ) proc ON proc.mailitem_id = ai.mailitem_id
      OUTER APPLY (
        SELECT TOP (1)
          ISNULL(el.[description], '') AS last_error
        FROM msdb.dbo.sysmail_event_log el
        WHERE el.mailitem_id = ai.mailitem_id
          AND LOWER(ISNULL(el.event_type, '')) = 'error'
        ORDER BY el.log_date DESC, el.event_log_id DESC
      ) evt
      WHERE 1 = 1
      ${statusClause}
      ORDER BY ai.mailitem_id DESC
    `,
    statusFilter
      ? [{ name: "statusFilter", type: sql.NVarChar(20), value: statusFilter }]
      : [],
    target
  );

  return rows.map(row => ({
    target,
    mailItemId: Number(row.mailitem_id),
    profileId: row.profile_id === null || row.profile_id === undefined ? null : Number(row.profile_id),
    profileName: String(row.profile_name || ""),
    recipients: String(row.recipients || ""),
    copyRecipients: String(row.copy_recipients || ""),
    blindCopyRecipients: String(row.blind_copy_recipients || ""),
    subject: String(row.subject || ""),
    bodyFormat: String(row.body_format || ""),
    sentStatus: String(row.sent_status || ""),
    normalizedStatus: normalizeMailSentStatus(row.sent_status),
    fromAddress: String(row.from_address || ""),
    replyTo: String(row.reply_to || ""),
    sendRequestUser: String(row.send_request_user || ""),
    importance: String(row.importance || ""),
    sendRequestDate: row.send_request_date || null,
    sentDate: row.sent_date || null,
    lastModDate: row.last_mod_date || null,
    lastError: String(row.last_error || ""),
    lastProcessId: row.last_process_id === null || row.last_process_id === undefined ? null : Number(row.last_process_id)
  }));
}

app.get("/api/db/dbmail-callers", authMiddleware, async (req, res) => {
  try {
    const requestedTarget = req.query?.target ? String(req.query.target).toLowerCase() : "all";
    const targets = requestedTarget === "all"
      ? ["prod", "test"]
      : [resolveRemoteTarget(requestedTarget)];

    const results = [];
    const errors = [];
    for (const target of targets) {
      const scan = await fetchDbMailCallersByTarget(target);
      results.push(...scan.findings);
      errors.push(...scan.errors);
    }

    const grouped = {};
    for (const row of results) {
      if (!grouped[row.target]) grouped[row.target] = {};
      if (!grouped[row.target][row.database]) grouped[row.target][row.database] = [];
      grouped[row.target][row.database].push(row);
    }

    Object.keys(grouped).forEach(target => {
      Object.keys(grouped[target]).forEach(databaseName => {
        grouped[target][databaseName].sort((a, b) => {
          const schemaCompare = a.schema.localeCompare(b.schema);
          if (schemaCompare !== 0) return schemaCompare;
          return a.objectName.localeCompare(b.objectName);
        });
      });
    });

    res.json({
      ok: true,
      targets,
      totalObjects: results.length,
      objectsByTarget: grouped,
      errors
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/db/sqlmail-monitor", authMiddleware, async (req, res) => {
  try {
    const requestedTarget = req.query?.target ? String(req.query.target).toLowerCase() : "all";
    const statusFilterRaw = req.query?.status ? String(req.query.status).toLowerCase() : "";
    const topRaw = Number(req.query?.top);
    const top = Number.isInteger(topRaw) && topRaw > 0 ? Math.min(topRaw, 2000) : 300;

    const targets = requestedTarget === "all"
      ? ["prod", "test"]
      : [resolveRemoteTarget(requestedTarget)];
    const allowedStatuses = new Set(["sent", "failed", "retrying", "unsent"]);
    const statusFilter = allowedStatuses.has(statusFilterRaw) ? statusFilterRaw : "";

    const items = [];
    const errors = [];
    const callerHintsByTarget = {};
    for (const target of targets) {
      try {
        const rows = await fetchSqlMailActivityByTarget(target, { statusFilter, top });
        items.push(...rows);
      } catch (error) {
        errors.push({
          target,
          error: error?.message || "Error desconocido leyendo msdb.dbo.sysmail_allitems."
        });
      }

      try {
        const scan = await fetchDbMailCallersByTarget(target);
        callerHintsByTarget[target] = scan.findings
          .map(item => `${item.database}.${item.schema}.${item.objectName}`)
          .slice(0, 6);
        if (Array.isArray(scan.errors) && scan.errors.length > 0) {
          errors.push(...scan.errors);
        }
      } catch (error) {
        errors.push({
          target,
          error: error?.message || "Error desconocido consultando procesos que usan sp_send_dbmail."
        });
      }
    }

    items.sort((a, b) => {
      if (a.mailItemId !== b.mailItemId) return b.mailItemId - a.mailItemId;
      return a.target.localeCompare(b.target);
    });

    const statusSummary = items.reduce((acc, item) => {
      const key = item.normalizedStatus || "other";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const requesterSummary = Object.entries(
      items.reduce((acc, item) => {
        const key = String(item.sendRequestUser || "").trim() || "(sin dato)";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {})
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([requester, count]) => ({ requester, count }));

    const enrichedItems = items.map(item => {
      const processId = item.lastProcessId;
      const targetHints = callerHintsByTarget[item.target] || [];
      const processParts = [];
      if (processId !== null && processId !== undefined) processParts.push(`PID SQLMail ${processId}`);
      if (targetHints.length === 1) processParts.push(targetHints[0]);
      if (targetHints.length > 1) processParts.push(`Posibles objetos: ${targetHints.join(" | ")}`);
      const sqlProcessLabel = processParts.length ? processParts.join(" · ") : "(sin rastro de proceso)";

      return {
        ...item,
        sqlProcessLabel
      };
    });

    res.json({
      ok: true,
      targets,
      statusFilter: statusFilter || null,
      totalItems: enrichedItems.length,
      statusSummary,
      requesterSummary,
      items: enrichedItems,
      errors
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/db/remote-objects/selection", authMiddleware, async (req, res) => {
  try {
    const target = resolveRemoteTarget(req.body?.target || "prod");
    const selected = Array.isArray(req.body?.selectedObjects) ? req.body.selectedObjects : [];
    const normalizedSelected = selected
      .map(item => ({
        sourceDb: sanitizeSqlIdentifier(item?.sourceDb),
        procName: normalizeProcName(item?.procName)
      }))
      .filter(item => item.sourceDb && item.procName);

    await ensureRemoteVisibilityTable();
    await sqlQuery(
      `DELETE FROM dbo.MailRemoteProcedureVisibility
       WHERE Target = @target`,
      [{ name: "target", type: sql.NVarChar(20), value: target }]
    );

    for (const item of normalizedSelected) {
      await sqlQuery(
        `
          INSERT INTO dbo.MailRemoteProcedureVisibility(Target, SourceDb, ProcName, IsVisible, UpdatedBy)
          VALUES(@target, @sourceDb, @procName, 1, @updatedBy)
        `,
        [
          { name: "target", type: sql.NVarChar(20), value: target },
          { name: "sourceDb", type: sql.NVarChar(128), value: item.sourceDb },
          { name: "procName", type: sql.NVarChar(128), value: item.procName },
          { name: "updatedBy", type: sql.NVarChar(200), value: req.session?.username || "panel" }
        ]
      );
    }

    res.json({ ok: true, target, selectedCount: normalizedSelected.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
