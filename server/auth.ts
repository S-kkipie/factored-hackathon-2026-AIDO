import type { Database } from "bun:sqlite";
import { SignJWT, errors, jwtVerify } from "jose";
import type { ServerConfig } from "./config";
import type { ServingDb } from "./db/serving";
import { type Val, val } from "./provenance";

export type Role = "customer" | "agent";
export type Language = "es" | "pt";

export interface Session {
  sessionId: string;
  role: Role;
  customerId: Val<string> | null;
  language: Language;
  expiresAt: number;
}

export class AuthError extends Error {
  constructor(
    readonly ruleId: "IN_AUTH_001" | "IN_AUTH_002" | "IN_SESSION_EXPIRED" | "IN_SESSION_REVOKED",
    message: string,
  ) {
    super(`${ruleId}: ${message}`);
  }
}

export interface Auth {
  login(persona: string, pin: string, language: Language): Promise<{ token: string; session: Session }>;
  agentLogin(pin: string): Promise<{ token: string; session: Session }>;
  verify(token: string): Promise<Session>;
}

type AuthConfig = Pick<ServerConfig, "jwtSecret" | "sessionTtlSeconds" | "demoPin" | "agentPin">;

export function createAuth(cfg: AuthConfig, serving: ServingDb, ops: Database, now: () => number = Date.now): Auth {
  const issue = async (role: Role, customerId: string | null, language: Language) => {
    const sessionId = crypto.randomUUID();
    const iat = Math.floor(now() / 1000);
    const exp = iat + cfg.sessionTtlSeconds;
    ops
      .query(
        "insert into sessions (session_id, customer_id, role, language, created_at, expires_at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(sessionId, customerId, role, language, new Date(iat * 1000).toISOString(), new Date(exp * 1000).toISOString());
    const token = await new SignJWT({ sid: sessionId, role, lang: language })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(customerId ?? "agent")
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(cfg.jwtSecret);
    const session: Session = {
      sessionId,
      role,
      customerId: customerId ? val(customerId, "jwt") : null,
      language,
      expiresAt: exp * 1000,
    };
    return { token, session };
  };

  return {
    async login(persona, pin, language) {
      const user = serving.demoUsers().find((d) => d.persona === persona);
      if (!user || pin !== cfg.demoPin) throw new AuthError("IN_AUTH_001", "invalid demo credentials");
      return issue("customer", user.customer_id, language);
    },
    async agentLogin(pin) {
      if (pin !== cfg.agentPin) throw new AuthError("IN_AUTH_001", "invalid agent credentials");
      return issue("agent", null, "es");
    },
    async verify(token) {
      let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
      try {
        ({ payload } = await jwtVerify(token, cfg.jwtSecret, { algorithms: ["HS256"], currentDate: new Date(now()) }));
      } catch (e) {
        if (e instanceof errors.JWTExpired) throw new AuthError("IN_SESSION_EXPIRED", "session expired");
        throw new AuthError("IN_AUTH_002", "invalid token");
      }
      const sessionId = String(payload.sid);
      const row = ops
        .query<{ status: string; language: Language; role: Role; customer_id: string | null }, [string]>(
          "select status, language, role, customer_id from sessions where session_id = ?",
        )
        .get(sessionId);
      if (!row || row.status !== "active") throw new AuthError("IN_SESSION_REVOKED", "session is not active");
      return {
        sessionId,
        role: row.role,
        customerId: row.customer_id ? val(row.customer_id, "jwt") : null,
        language: row.language,
        expiresAt: (payload.exp ?? 0) * 1000,
      };
    },
  };
}
