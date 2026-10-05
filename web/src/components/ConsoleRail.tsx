import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { api } from "../api";
import { type AgentSession, session } from "../session";
import { Guilloche, Wordmark } from "./Brand";
import { ThemeToggle } from "./ThemeToggle";

/** Left rail shared by the agent console and the supervision dashboard. */
export function ConsoleRail({ agent, onLogout, children }: { agent: AgentSession; onLogout: () => void; children?: ReactNode }) {
  return (
    <aside className="console-rail">
      <Guilloche className="sidebar-rosette" opacity={0.22} />
      <Wordmark size={32} sub="Equipo AIDO" light />
      <nav className="side-nav" aria-label="Consola">
        <Link to="/agent" className="side-link" activeProps={{ className: "side-link active" }} activeOptions={{ exact: true }}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M4 5h16v11H8l-4 4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          </svg>
          Casos
        </Link>
        <Link to="/supervision" className="side-link" activeProps={{ className: "side-link active" }}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M4 20V10m6 10V4m6 16v-7m4 7H3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          Supervisión
        </Link>
      </nav>
      {children}
      <ThemeToggle />
      <button
        type="button"
        className="ghost full"
        onClick={async () => {
          await api.logout(agent.token).catch(() => {});
          session.setAgent(null);
          onLogout();
        }}
      >
        Cerrar sesión
      </button>
    </aside>
  );
}
