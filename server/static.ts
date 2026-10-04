import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Vite emits no inline scripts; inline style attributes (duration bars) need 'unsafe-inline' for styles only.
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

/**
 * Serves the built web app (`web/dist`) next to the API: files by path, `index.html` for app routes (SPA
 * fallback), 404 for missing assets. Returns null for `/api` paths so the API keeps its own 404, and null when
 * there is no build. Paths that resolve outside the build directory are never read.
 */
export function webHandler(distDir: string): ((pathname: string) => Response | null) | null {
  const index = join(distDir, "index.html");
  if (!existsSync(index)) return null;
  const root = normalize(distDir + sep);
  return (pathname) => {
    if (pathname === "/api" || pathname.startsWith("/api/")) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const file = normalize(join(distDir, decoded));
    if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) {
      if (file === index) return new Response(Bun.file(index), { headers: HTML_HEADERS });
      const immutable = decoded.startsWith("/assets/");
      return new Response(Bun.file(file), {
        headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache", "x-content-type-options": "nosniff" },
      });
    }
    // A path with a file extension is a missing asset, not an app route.
    if (/\.[a-z0-9]+$/i.test(decoded)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(index), { headers: HTML_HEADERS });
  };
}
