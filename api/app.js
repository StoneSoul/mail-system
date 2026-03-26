import express from "express";
import { mailQueue } from "../queue/mailQueue.js";
import { query } from "../services/db.js";
import dotenv from "dotenv";

import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

dotenv.config();

const app = express();
app.use(express.json());

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
// Ahora podés acceder a http://localhost:3000/admin/queues

// ------------------------
// Endpoints API
// ------------------------
app.get("/", (req, res) => {
  res.send({
    ok: true,
    service: "mail-system-api",
    routes: ["/send", "/mails", "/mails/retry/:id", "/admin/queues"]
  });
});

app.post("/send", async (req, res) => {
  const { to, subject, body, senderProfile } = req.body;

  const result = await query(`
    INSERT INTO MailQueue (to_email, subject, body)
    OUTPUT INSERTED.*
    VALUES ('${to}', '${subject}', '${body}')
  `);

  const mail = result.recordset[0];

  await mailQueue.add("mail", { ...mail, senderProfile: senderProfile || "default" });

  res.send({ ok: true });
});

app.get("/mails", async (req, res) => {
  const result = await query("SELECT * FROM MailQueue ORDER BY id DESC");
  res.send(result.recordset);
});

// Reintento manual de mails
app.post("/mails/retry/:id", async (req, res) => {
  const id = req.params.id;
  const result = await query(`SELECT * FROM MailQueue WHERE id=${id}`);
  const mail = result.recordset[0];
  if (!mail) return res.status(404).send({ error: "Mail no encontrado" });

  await mailQueue.add("mail", { ...mail, senderProfile: mail.sender_profile || "default" });
  res.send({ ok: true, msg: "Mail reenviado a la cola" });
});

app.listen(3000, () => console.log("API running on port 3000"));
