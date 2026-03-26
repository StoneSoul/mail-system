import express from "express";
import sql from "mssql";
import dotenv from "dotenv";
import { mailQueue } from "../queue/mailQueue.js";
import { query } from "../services/db.js";

import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

dotenv.config();

const app = express();
app.use(express.json());

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

app.use("/admin/queues", serverAdapter.getRouter());

// ------------------------
// Endpoints API
// ------------------------
app.get("/", (_req, res) => {
  res.send({
    ok: true,
    service: "mail-system-api",
    routes: [
      "/send",
      "/mails",
      "/mails/retry/:id",
      "/admin/queues",
      "/api/metrics",
      "/api/queue",
      "/api/actions/run-sender",
      "/api/actions/requeue-failed",
      "/api/actions/run-producer",
      "/api/audit"
    ]
  });
});

app.post("/send", async (req, res) => {
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

app.get("/mails", async (_req, res) => {
  const result = await query("SELECT * FROM MailQueue ORDER BY id DESC");
  res.send(result.recordset);
});

app.post("/mails/retry/:id", async (req, res) => {
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
app.get("/api/metrics", async (_req, res) => {
  try {
    const data = await sqlQuery("SELECT * FROM dbo.VW_MAILQUEUE_METRICS");
    res.json(data[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/queue", async (req, res) => {
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

app.post("/api/actions/run-sender", async (req, res) => {
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

app.post("/api/actions/requeue-failed", async (req, res) => {
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

app.post("/api/actions/run-producer", async (req, res) => {
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

app.get("/api/audit", async (_req, res) => {
  try {
    const data = await sqlQuery("SELECT TOP 100 * FROM dbo.MailAdminAudit ORDER BY Id DESC");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`API running on port ${port}`));
