import express from "express";
import sql from "mssql";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

import { mailQueue } from "../queue/mailQueue.js";
import { query } from "../services/db.js";

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

const PANEL_USER = process.env.PANEL_USER || "admin";
const PANEL_PASS = process.env.PANEL_PASS || "admin123";
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
// SQL config + helpers
// ------------------------
const sqlConfig = {
  user: process.env.DB_USER || process.env.SQL_USER,
  password: process.env.DB_PASS || process.env.SQL_PASSWORD,
  server: process.env.DB_SERVER || process.env.SQL_SERVER,
  database: process.env.DB_NAME || process.env.SQL_DATABASE,
  options: {
    encrypt: false,
    trustServerCertificate: true
  }
};

async function sqlQuery(text, inputs = []) {
  const pool = await sql.connect(sqlConfig);
  const request = pool.request();
  for (const input of inputs) {
    request.input(input.name, input.type, input.value);
  }
  const result = await request.query(text);
  return result.recordset;
}

async function executeProcedure(name, inputs = []) {
  const pool = await sql.connect(sqlConfig);
  const request = pool.request();
  for (const input of inputs) {
    request.input(input.name, input.type, input.value);
  }
  await request.execute(name);
}

function escapeSqlString(value) {
  return String(value).replace(/'/g, "''");
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

app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};

  if (username !== PANEL_USER || password !== PANEL_PASS) {
    return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
  }

  const sessionId = createSession(username);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`
  );

  return res.json({ ok: true, user: username });
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
  const id = Number(req.params.id);
  const result = await query(`SELECT * FROM MailQueue WHERE id=${id}`);
  const mail = result.recordset[0];
  if (!mail) return res.status(404).send({ error: "Mail no encontrado" });

  await mailQueue.add("mail", { ...mail, senderProfile: mail.sender_profile || "default" });
  res.send({ ok: true, msg: "Mail reenviado a la cola" });
});

// ------------------------
// Endpoints Fullboard SQL-first (MVP)
// ------------------------
app.get("/api/metrics", authMiddleware, async (_req, res) => {
  try {
    const data = await sqlQuery("SELECT * FROM dbo.VW_MAILQUEUE_METRICS");
    res.json(data[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/queue", authMiddleware, async (req, res) => {
  try {
    const status = req.query.status;
    const where = status ? "WHERE [status]=@status" : "";
    const data = await sqlQuery(
      `SELECT TOP 200 id,to_email,[subject],[status],retries,error_message,MailProfile,created_at,last_attempt
       FROM dbo.MailQueue ${where} ORDER BY id DESC`,
      [{ name: "status", type: sql.NVarChar(20), value: status || null }]
    );
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/actions/run-sender", authMiddleware, async (req, res) => {
  try {
    const { maxItems = 100, user = "web" } = req.body || {};
    await executeProcedure("dbo.SP_ADMIN_RUN_SENDER", [
      { name: "MaxItems", type: sql.Int, value: maxItems },
      { name: "ExecutedBy", type: sql.NVarChar(200), value: user }
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/actions/requeue-failed", authMiddleware, async (req, res) => {
  try {
    const { user = "web" } = req.body || {};
    await executeProcedure("dbo.SP_ADMIN_REQUEUE_FAILED", [
      { name: "ExecutedBy", type: sql.NVarChar(200), value: user }
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/actions/run-producer", authMiddleware, async (req, res) => {
  try {
    const { procName, user = "web" } = req.body || {};
    await executeProcedure("dbo.SP_ADMIN_RUN_PRODUCER", [
      { name: "ProcName", type: sql.NVarChar(128), value: procName },
      { name: "ExecutedBy", type: sql.NVarChar(200), value: user }
    ]);
    res.json({ ok: true });
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