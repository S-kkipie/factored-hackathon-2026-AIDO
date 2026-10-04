import { Link, Outlet } from "@tanstack/react-router";
import { Logo } from "./Brand";

export function Layout() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/login" className="brand">
          <Logo size={32} />
          <span>
            LATAM Bank <span className="muted">· AIDO</span>
          </span>
        </Link>
        <nav className="nav">
          <Link to="/chat" activeProps={{ className: "active" }}>
            Chat
          </Link>
          <Link to="/agent" activeProps={{ className: "active" }}>
            Consola de agentes
          </Link>
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
