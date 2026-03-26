import React, { useEffect, useState } from "react";
import { getMails, retryMail } from "../services/api.js";

export default function MailTable({ status }) {
  const [mails, setMails] = useState([]);
  const [error, setError] = useState("");

  async function load() {
    try {
      const data = await getMails(status);
      setMails(data);
      setError("");
    } catch {
      setError("No se pudieron cargar los mails. Verificá tu sesión.");
    }
  }

  async function handleRetry(id) {
    await retryMail(id);
    load();
  }

  useEffect(() => {
    load();
  }, [status]);

  return (
    <div>
      <h2>{status || "Todos"} mails</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table border="1" cellPadding="5">
        <thead>
          <tr>
            <th>ID</th><th>Email</th><th>Asunto</th><th>Status</th><th>Error</th><th>Retries</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {mails.map(m => (
            <tr key={m.id}>
              <td>{m.id}</td>
              <td>{m.to_email}</td>
              <td>{m.subject}</td>
              <td>{m.status}</td>
              <td>{m.error_message}</td>
              <td>{m.retries}/{m.max_retries}</td>
              <td>
                {m.status === "Failed" && <button onClick={() => handleRetry(m.id)}>Reintentar</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
