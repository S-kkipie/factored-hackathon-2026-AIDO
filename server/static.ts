import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

/**
 * Serves the built web UI (web/dist) from the API server, so production is one container (spec 4.1). Unknown
 * non-API paths fall back to index.html for client-side routes; /api/* never falls through to the UI.
 */
export function staticHandler(distDir: string): ((pathname: string) => Response | null) | null {
  const index = join(distDir, "index.html");
  if (!existsSync(index)) return null;
  const root = normalize(distDir + sep);
  return (pathname) => {
    if (pathname.startsWith("/api/") || pathname === "/api") return null;
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    const file = normalize(join(distDir, rel));
    if (!file.startsWith(root)) return new Response("Not Found", { status: 404 });
    const target = existsSync(file) && statSync(file).isFile() ? file : index;
    const immutable = target !== index && rel.startsWith("/assets/");
    return new Response(Bun.file(target), {
      headers: {
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  };
}
