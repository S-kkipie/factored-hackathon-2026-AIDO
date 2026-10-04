import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { Guilloche, Logo, Wordmark } from "./Brand";

/** The two nav links every signed-in area (customer or agent) can reach, regardless of chrome. */
function NavLinks({ linkClass }: { linkClass: string }) {
  return (
    <>
      <Link to="/chat" className={linkClass} activeProps={{ className: `${linkClass} active` }}>
        Chat
      </Link>
      <Link to="/agent" className={linkClass} activeProps={{ className: `${linkClass} active` }}>
        Consola de agentes
      </Link>
    </>
  );
}

/**
 * Root chrome, route-aware (presentational only — no auth/session logic lives here):
 * - /login renders its own full-bleed hero + brand, so no generic header.
 * - /agent gets the dark-emerald console rail (brand + nav); AgentPage keeps its own sign-in/sign-out.
 * - everything else (/chat, /trace/*) keeps the light top bar.
 */
export function Layout() {
  const pathname = useLocation({ select: (loc) => loc.pathname });

  if (pathname === "/login") {
    return <Outlet />;
  }

  if (pathname.startsWith("/agent")) {
    return (
      <div className="app">
        <div className="shell-with-rail">
          <aside className="console-rail">
            <Guilloche className="sidebar-rosette" opacity={0.22} />
            <Wordmark size={32} sub="Equipo AIDO" light />
            <nav className="side-nav" aria-label="Consola">
              <NavLinks linkClass="side-link" />
            </nav>
          </aside>
          <main className="main rail-main">
            <Outlet />
          </main>
        </div>
      </div>
    );
  }

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
          <NavLinks linkClass="" />
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
