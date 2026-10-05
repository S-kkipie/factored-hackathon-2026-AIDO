/** Light by default; dark only when the viewer turns it on. The choice is a per-browser convenience. */
export type Theme = "light" | "dark";

const KEY = "aido.theme";

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme) {
  if (theme === "dark") document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}
