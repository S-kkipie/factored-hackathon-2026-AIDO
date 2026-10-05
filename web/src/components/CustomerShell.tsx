import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api";
import { ChatProvider, useChat } from "../chat";
import { strings } from "../i18n";
import { type CustomerSession, session } from "../session";
import { Guilloche, Wordmark } from "./Brand";
import { ThemeToggle } from "./ThemeToggle";

const ICONS = {
  home: <path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
  chat: <path d="M4 5h16v11H8l-4 4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
  cases: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 9h8M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
};

function Nav({ s }: { s: CustomerSession }) {
  const t = strings[s.language];
  const chat = useChat();
  const navigate = useNavigate();
  const ask = async (q: string) => {
    await navigate({ to: "/chat" });
    void chat.send(q);
  };
  const link = (to: "/inicio" | "/chat" | "/casos", icon: keyof typeof ICONS, label: string, badge?: boolean) => (
    <Link to={to} className="side-link" activeProps={{ className: "side-link active" }}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        {ICONS[icon]}
      </svg>
      {label}
      {badge && <span className="side-badge" aria-label="nuevo" />}
    </Link>
  );
  return (
    <aside className="sidebar">
      <Wordmark size={36} sub={t.brandTagline} light />
      <nav className="side-nav" aria-label={t.navLabel}>
        {link("/inicio", "home", t.navHome)}
        {link("/chat", "chat", t.assistantNav, chat.pending !== null)}
        {link("/casos", "cases", t.navCases)}
      </nav>
      <section className="side-section">
        <h3>{t.quickTopics}</h3>
        {t.suggestions.map((q) => (
          <button key={q} type="button" className="side-topic" onClick={() => void ask(q)} disabled={chat.busy || chat.expired}>
            {q}
          </button>
        ))}
      </section>
    </aside>
  );
}

function Foot({ s }: { s: CustomerSession }) {
  const t = strings[s.language];
  const navigate = useNavigate();
  return (
    <div className="side-foot">
      <div className="side-user">
        <span className="side-user-dot" aria-hidden="true" />
        <div>
          <div className="side-user-name">{t.personas[s.persona] ?? s.persona}</div>
          <div className="muted small">{s.language === "es" ? "Español" : "Português"}</div>
        </div>
      </div>
      <ThemeToggle language={s.language} />
      <button
        type="button"
        className="ghost full"
        onClick={async () => {
          await api.logout(s.token).catch(() => {});
          session.setCustomer(null);
          await navigate({ to: "/login" });
        }}
      >
        {t.logout}
      </button>
    </div>
  );
}

/** Customer layout: navigation + the shared conversation, so switching sections never drops the chat. */
export function CustomerShell() {
  const [s] = useState(() => session.customer());
  if (!s) return null;
  return (
    <ChatProvider session={s}>
      <div className="app-shell">
        <div className="sidebar-wrap">
          <Guilloche className="sidebar-rosette" opacity={0.22} />
          <Nav s={s} />
          <Foot s={s} />
        </div>
        <Outlet />
      </div>
    </ChatProvider>
  );
}
