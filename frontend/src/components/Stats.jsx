import React, { useEffect, useState } from "react";
import { getStats } from "../services/api.js";

export default function Stats() {
  const [stats, setStats] = useState({sent:0, failed:0, pending:0, total:0});

  useEffect(() => {
    async function load() {
      setStats(await getStats());
    }
    load();
  }, []);

  return (
    <div>
      <h3>Dashboard de mails</h3>
      <ul>
        <li>Total: {stats.total}</li>
        <li>Enviados: {stats.sent}</li>
        <li>Fallidos: {stats.failed}</li>
        <li>Pendientes: {stats.pending}</li>
      </ul>
    </div>
  );
}