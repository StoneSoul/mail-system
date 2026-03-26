const express = require("express");
const cors = require("cors");
const sql = require("mssql");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const dbConfig = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DATABASE,
  options: { trustServerCertificate: true }
};

async function q(query, params = []) {
  const pool = await sql.connect(dbConfig);
  const req = pool.request();
  params.forEach((p) => req.input(p.name, p.type, p.value));
  const r = await req.query(query);
  return r.recordset;
}

app.get("/api/metrics", async (_req, res) => {
  try {
    const data = await q("SELECT * FROM dbo.VW_MAILQUEUE_METRICS");
    res.json(data[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/queue", async (req, res) => {
  try {
    const status = req.query.status;
    const where = status ? "WHERE [status]=@status" : "";
    const pool = await sql.connect(dbConfig);
    const r = await pool
      .request()
      .input("status", sql.NVarChar(20), status || null)
      .query(`SELECT TOP 200 id,to_email,[subject],[status],retries,error_message,MailProfile,created_at,last_attempt
              FROM dbo.MailQueue ${where} ORDER BY id DESC`);
    res.json(r.recordset);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/actions/run-sender", async (req, res) => {
  try {
    const { maxItems = 100, user = "web" } = req.body || {};
    const pool = await sql.connect(dbConfig);
    await pool
      .request()
      .input("MaxItems", sql.Int, maxItems)
      .input("ExecutedBy", sql.NVarChar(200), user)
      .execute("dbo.SP_ADMIN_RUN_SENDER");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/actions/requeue-failed", async (req, res) => {
  try {
    const { user = "web" } = req.body || {};
    const pool = await sql.connect(dbConfig);
    await pool
      .request()
      .input("ExecutedBy", sql.NVarChar(200), user)
      .execute("dbo.SP_ADMIN_REQUEUE_FAILED");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/actions/run-producer", async (req, res) => {
  try {
    const { procName, user = "web" } = req.body || {};
    const pool = await sql.connect(dbConfig);
    await pool
      .request()
      .input("ProcName", sql.NVarChar(128), procName)
      .input("ExecutedBy", sql.NVarChar(200), user)
      .execute("dbo.SP_ADMIN_RUN_PRODUCER");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/audit", async (_req, res) => {
  try {
    const data = await q("SELECT TOP 100 * FROM dbo.MailAdminAudit ORDER BY Id DESC");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 3001, () => console.log("API mail fullboard up"));
