import { useState } from "react";
import { applyTheme, storedTheme } from "../theme";

/** Switches between the default light theme and the opt-in dark theme. */
export function ThemeToggle({ language = "es" }: { language?: "es" | "pt" }) {
  const [dark, setDark] = useState(() => storedTheme() === "dark");
  const label = dark ? "Modo claro" : language === "pt" ? "Modo escuro" : "Modo oscuro";
  return (
    <button
      type="button"
      className="ghost full theme-toggle"
      aria-pressed={dark}
      onClick={() => {
        applyTheme(dark ? "light" : "dark");
        setDark(!dark);
      }}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        {dark ? (
          <>
            <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </>
        ) : (
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        )}
      </svg>
      {label}
    </button>
  );
}
