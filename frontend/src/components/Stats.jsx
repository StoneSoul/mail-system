import React, { useEffect, useState } from "react";
import { getStats } from "../services/api.js";

const STAT_LABELS = [
  { key: "total", label: "Total" },
  { key: "sent", label: "Enviados" },
  { key: "failed", label: "Fallidos" },
  { key: "pending", label: "Pendientes" }
];

export default function Stats() {
  const [stats, setStats] = useState({ sent: 0, failed: 0, pending: 0, total: 0 });
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setStats(await getStats());
        setError("");
      } catch {
        setError("No se pudieron cargar las métricas. Verificá tu sesión.");
      }
    }
    load();
  }, []);

  return (
    <div>
      <h3>Dashboard de mails</h3>
      {error && <p className="error-text">{error}</p>}
      <div className="stats-grid">
        {STAT_LABELS.map(item => (
          <article key={item.key} className="stat-card">
            <strong>{item.label}</strong>
            <span>{stats[item.key] ?? 0}</span>
          </article>
        ))}
      </div>
    </div>
  );
}
