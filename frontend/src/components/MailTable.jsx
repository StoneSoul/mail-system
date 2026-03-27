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

  function formatRetries(mail) {
    const retries = Number.isFinite(Number(mail?.retries)) ? Number(mail.retries) : 0;
    const maxRetries = Number.isFinite(Number(mail?.max_retries)) ? Number(mail.max_retries) : null;
    return maxRetries === null ? `${retries}` : `${retries}/${maxRetries}`;
  }

  function formatField(value) {
    if (value === null || value === undefined || value === "") {
      return "—";
    }

    return value;
  }

  return (
    <div className="table-section">
      <h2>{status || "Todos"} mails</h2>
      {error && <p className="error-text">{error}</p>}

      <div className="table-toolbar">
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

      {mails.length === 0 ? (
        <p className="empty-state">No hay resultados para mostrar con este filtro.</p>
      ) : (
        <div className="table-shell">
          <table>
            <colgroup>
              <col style={{ width: "46px" }} />
              <col style={{ width: "72px" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "22%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "30%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "130px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={mails.length > 0 && selectedIds.length === mails.length}
                    onChange={toggleSelectAllVisible}
                  />
                </th>
                <th>ID</th>
                <th>Email</th>
                <th>Asunto</th>
                <th>Status</th>
                <th>Error</th>
                <th>Retries</th>
                <th>Acciones</th>
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
                  <td className="cell-wrap">{formatField(m.to_email)}</td>
                  <td className="cell-wrap">{formatField(m.subject)}</td>
                  <td>{formatField(m.status)}</td>
                  <td className="cell-wrap">{formatField(m.error_message)}</td>
                  <td>{formatRetries(m)}</td>
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
      )}
    </div>
  );
}
