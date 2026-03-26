import React, { useEffect, useState } from "react";
import MailTable from "./components/MailTable.jsx";
import Stats from "./components/Stats.jsx";
import { getAuthStatus, login, logout } from "./services/api.js";

const VIEWS = ["Dashboard", "Pending", "Failed", "Sent"];

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [activeView, setActiveView] = useState("Dashboard");

  useEffect(() => {
    let isMounted = true;

    async function bootstrapAuth() {
      try {
        const status = await getAuthStatus();
        if (isMounted) {
          setAuthed(Boolean(status?.loggedIn));
        }
      } catch (_error) {
        if (isMounted) {
          setAuthed(false);
        }
      } finally {
        if (isMounted) {
          setCheckingAuth(false);
        }
      }
    }

    bootstrapAuth();

    return () => {
      isMounted = false;
    };
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");

    try {
      await login(username, password);
      setAuthed(true);
    } catch (err) {
      if (err?.response?.status === 401) {
        setError("Usuario o clave incorrectos");
      } else {
        setError("No se pudo iniciar sesión. Verificá la conexión con la API.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleLogout() {
    try {
      await logout();
    } finally {
      setAuthed(false);
      setUsername("");
      setPassword("");
    }
  }

  if (checkingAuth) {
    return (
      <div style={{ maxWidth: 420, margin: "40px auto", fontFamily: "Arial" }}>
        <h1>Mail System - Login</h1>
        <p>Verificando sesión…</p>
      </div>
    );
  }

  if (!authed) {
    return (
      <div style={{ maxWidth: 420, margin: "40px auto", fontFamily: "Arial" }}>
        <h1>Mail System - Login</h1>
        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: 12 }}>
            <label>Usuario</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              style={{ width: "100%", padding: 8 }}
              required
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label>Clave</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={{ width: "100%", padding: 8 }}
              required
            />
          </div>
          {error && <p style={{ color: "red" }}>{error}</p>}
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Ingresando..." : "Ingresar"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "Arial", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Mail System Dashboard</h1>
        <button onClick={handleLogout}>Cerrar sesión</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {VIEWS.map(view => (
          <button key={view} onClick={() => setActiveView(view)} disabled={activeView === view}>
            {view}
          </button>
        ))}
      </div>

      {activeView === "Dashboard" && <Stats />}
      {activeView === "Pending" && <MailTable status="Pending" />}
      {activeView === "Failed" && <MailTable status="Failed" />}
      {activeView === "Sent" && <MailTable status="Sent" />}
    </div>
  );
}
