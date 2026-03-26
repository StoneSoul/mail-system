import React, { useEffect, useState } from "react";
import { getStats } from "../services/api.js";

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
      {error && <p style={{ color: "red" }}>{error}</p>}
      <ul>
        <li>Total: {stats.total}</li>
        <li>Enviados: {stats.sent}</li>
        <li>Fallidos: {stats.failed}</li>
        <li>Pendientes: {stats.pending}</li>
      </ul>
    </div>
  );
}
