import React, { useEffect, useState } from "react";
import { deleteQueueItems, getMails, retryMail } from "../services/api.js";

const ERROR_FILTERS = [
  { value: "", label: "Todos" },
  { value: "MAILBOX_FULL", label: "Buzón lleno" },
  { value: "MAILBOX_NOT_FOUND", label: "Mailbox inexistente" },
  { value: "SENDING_LIMIT", label: "Límite de envío" },
  { value: "TEMPORARY", label: "Temporal" },
  { value: "OTHER", label: "Otro" },
  { value: "UNKNOWN", label: "Desconocido" }
];

export default function MailTable({ status }) {
  const [mails, setMails] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [errorCategory, setErrorCategory] = useState("");

  async function load() {
    try {
      const data = await getMails(status, status === "Failed" ? errorCategory : "");
      setMails(data);
      setSelectedIds([]);
      setError("");
    } catch {
      setError("No se pudieron cargar los mails. Verificá tu sesión.");
    }
  }

  async function handleRetry(id) {
    setBusy(true);
    try {
      await retryMail(id);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteSelected() {
    if (selectedIds.length === 0) return;
    setBusy(true);
    try {
      await deleteQueueItems({ ids: selectedIds });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteFiltered() {
    setBusy(true);
    try {
      await deleteQueueItems({
        status,
        errorCategory: status === "Failed" ? errorCategory : undefined
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  function toggleSelection(id) {
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  }

  function toggleSelectAllVisible() {
    if (selectedIds.length === mails.length) {
      setSelectedIds([]);
      return;
    }
    setSelectedIds(mails.map(m => m.id));
  }

  useEffect(() => {
    load();
  }, [status, errorCategory]);

  return (
    <div>
      <h2>{status || "Todos"} mails</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}

      <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
        {status === "Failed" && (
          <>
            <label htmlFor="errorCategory">Filtro error:</label>
            <select
              id="errorCategory"
              value={errorCategory}
              onChange={e => setErrorCategory(e.target.value)}
              disabled={busy}
            >
              {ERROR_FILTERS.map(opt => (
                <option key={opt.value || "all"} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </>
        )}

        <button onClick={handleDeleteSelected} disabled={busy || selectedIds.length === 0}>
          Borrar seleccionados ({selectedIds.length})
        </button>
        <button onClick={handleDeleteFiltered} disabled={busy || mails.length === 0}>
          Borrar filtrados ({mails.length})
        </button>
      </div>

      <table border="1" cellPadding="5">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                checked={mails.length > 0 && selectedIds.length === mails.length}
                onChange={toggleSelectAllVisible}
              />
            </th>
            <th>ID</th><th>Email</th><th>Asunto</th><th>Status</th><th>Error</th><th>Retries</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {mails.map(m => (
            <tr key={m.id}>
              <td>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(m.id)}
                  onChange={() => toggleSelection(m.id)}
                />
              </td>
              <td>{m.id}</td>
              <td>{m.to_email}</td>
              <td>{m.subject}</td>
              <td>{m.status}</td>
              <td>{m.error_message}</td>
              <td>{m.retries}/{m.max_retries}</td>
              <td>
                {m.status === "Failed" && (
                  <button onClick={() => handleRetry(m.id)} disabled={busy}>
                    Reintentar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
