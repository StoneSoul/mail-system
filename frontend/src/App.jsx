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
  const [showSettings, setShowSettings] = useState(false);

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
      <main className="auth-shell">
        <section className="auth-card">
          <h1>Mail System - Login</h1>
          <p>Verificando sesión…</p>
        </section>
      </main>
    );
  }

  if (!authed) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <h1>Mail System - Login</h1>
          <form onSubmit={handleLogin} className="auth-form">
            <div>
              <label htmlFor="username">Usuario</label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="password">Clave</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>
            {error && <p className="error-text">{error}</p>}
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Ingresando..." : "Ingresar"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <header className="page-header">
        <h1>Mail System Dashboard</h1>
        <div className="header-actions">
          <button
            onClick={() => setShowSettings(prev => !prev)}
            aria-haspopup="true"
            aria-expanded={showSettings}
          >
            ⚙️ Ajustes
          </button>
          {showSettings && (
            <div className="settings-menu">
              <div className="settings-menu-items">
                <a href="/remote-objects">Revisar visibilidad de SP (dbo)</a>
                <a href="/dbmail-callers">Relevamiento de sp_send_dbmail</a>
                <a href="/sqlmail-monitor">Monitoreo SQL Mail</a>
              </div>
            </div>
          )}
          <button onClick={handleLogout}>Cerrar sesión</button>
        </div>
      </header>

      <nav className="view-switcher">
        {VIEWS.map(view => (
          <button key={view} onClick={() => setActiveView(view)} disabled={activeView === view}>
            {view}
          </button>
        ))}
      </nav>

      <section className="panel">
        {activeView === "Dashboard" && <Stats />}
        {activeView === "Pending" && <MailTable status="Pending" />}
        {activeView === "Failed" && <MailTable status="Failed" />}
        {activeView === "Sent" && <MailTable status="Sent" />}
      </section>
    </main>
  );
}
