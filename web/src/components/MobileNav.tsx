import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { Wordmark } from "./Brand";

/** Phone/tablet top bar: brand plus a menu button that opens a sheet with secondary actions. Hidden on desktop. */
export function MobileTopBar({ sub, menuLabel = "Menú", children }: { sub: string; menuLabel?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <header className="mobile-top">
      <Wordmark size={30} sub={sub} light />
      <button type="button" className="mobile-menu-btn" aria-label={menuLabel} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          {open ? (
            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          ) : (
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          )}
        </svg>
      </button>
      {open && (
        <>
          <div className="mobile-sheet-backdrop" onClick={() => setOpen(false)} />
          {/* Any action inside the sheet (a link, a topic, logout) also closes it. */}
          <div
            className="mobile-sheet"
            role="dialog"
            aria-label={menuLabel}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a, button")) setOpen(false);
            }}
          >
            {children}
          </div>
        </>
      )}
    </header>
  );
}

export interface MobileTab {
  to: "/inicio" | "/chat" | "/casos" | "/agent" | "/supervision";
  label: string;
  icon: ReactNode;
  badge?: boolean;
}

/** Bottom tab bar for the primary sections. Hidden on desktop. */
export function MobileTabs({ tabs, label }: { tabs: MobileTab[]; label: string }) {
  return (
    <nav className="mobile-tabs" aria-label={label}>
      {tabs.map((t) => (
        <Link key={t.to} to={t.to} className="mobile-tab" activeProps={{ className: "mobile-tab active" }} activeOptions={{ exact: true }}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            {t.icon}
          </svg>
          <span>{t.label}</span>
          {t.badge && <span className="mobile-tab-badge" aria-label="nuevo" />}
        </Link>
      ))}
    </nav>
  );
}
