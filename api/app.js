import express from "express";
import sql from "mssql";
import dotenv from "dotenv";
import crypto from "crypto";
import { mailQueue } from "../queue/mailQueue.js";
import { query } from "../services/db.js";

import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

dotenv.config();

const app = express();
app.use(express.json());

const AUTH_SECRET = process.env.AUTH_SECRET || "change-this-secret";
const AUTH_USER = process.env.AUTH_USER || "admin";
const AUTH_PASS = process.env.AUTH_PASS || "admin123";
const TOKEN_TTL_MS = 1000 * 60 * 60 * 8; // 8 horas

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

function createAuthToken(username) {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `${username}.${expiresAt}`;
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  return Buffer.from(`${payload}.${signature}`).toString("base64url");
}

function verifyAuthToken(token) {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [username, expiresAtRaw, signature] = decoded.split(".");
    if (!username || !expiresAtRaw || !signature) return false;

    const payload = `${username}.${expiresAtRaw}`;
    const expectedSig = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
    const isSigValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
    const isExpired = Number(expiresAtRaw) < Date.now();

    return isSigValid && !isExpired;
  } catch {
    return false;
  }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token || !verifyAuthToken(token)) {
    return res.status(401).json({ ok: false, error: "No autorizado" });
  }

  next();
}

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
// Auth
// ------------------------
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};

  if (username !== AUTH_USER || password !== AUTH_PASS) {
    return res.status(401).json({ ok: false, error: "Credenciales inválidas" });
  }

  const token = createAuthToken(username);
  return res.json({ ok: true, token });
});

// ------------------------
// Endpoints API
// ------------------------
app.get("/", (_req, res) => {
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

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API running on port ${port}`));
