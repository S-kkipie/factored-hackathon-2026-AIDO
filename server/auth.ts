import { SignJWT, errors, jwtVerify } from "jose";
import type { ServerConfig } from "./config";
import type { Sql } from "./db/sql";
import type { ServingDb } from "./db/serving";
import { type Val, val } from "./provenance";
import type { RuleId } from "./rules";

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
    readonly ruleId: Extract<RuleId, `IN_AUTH_${string}` | `IN_SESSION_${string}`>,
    message: string,
  ) {
    super(`${ruleId}: ${message}`);
  }
}

export type SessionStatus = "active" | "closed" | "handed_off";
const SESSION_STATUSES: readonly SessionStatus[] = ["active", "closed", "handed_off"];

export interface Auth {
  login(persona: string, pin: string, language: Language): Promise<{ token: string; session: Session }>;
  agentLogin(pin: string): Promise<{ token: string; session: Session }>;
  /** Verifies a token; by default only `active` sessions pass. Read-only endpoints may also allow `handed_off`. */
  verify(token: string, allow?: readonly SessionStatus[]): Promise<Session & { status: SessionStatus }>;
  /** Ends a session: its tokens stop verifying immediately. */
  revoke(sessionId: string): Promise<void>;
  setStatus(sessionId: string, status: SessionStatus): Promise<void>;
}

type AuthConfig = Pick<ServerConfig, "jwtSecret" | "sessionTtlSeconds" | "demoPin" | "agentPin">;

export function createAuth(cfg: AuthConfig, serving: ServingDb, ops: Sql, now: () => number = Date.now): Auth {
  const issue = async (role: Role, customerId: string | null, language: Language) => {
    const sessionId = crypto.randomUUID();
    const iat = Math.floor(now() / 1000);
    const exp = iat + cfg.sessionTtlSeconds;
    await ops.run(
      "insert into ops.sessions (session_id, customer_id, role, language, created_at, expires_at) values ($1, $2, $3, $4, $5, $6)",
      [sessionId, customerId, role, language, new Date(iat * 1000).toISOString(), new Date(exp * 1000).toISOString()],
    );
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

  const setStatus = async (sessionId: string, status: SessionStatus): Promise<void> => {
    if (!SESSION_STATUSES.includes(status)) throw new AuthError("IN_AUTH_002", `invalid session status '${String(status)}'`);
    const changed = await ops.run("update ops.sessions set status = $1 where session_id = $2", [status, sessionId]);
    if (changed === 0) throw new AuthError("IN_AUTH_002", `unknown session ${sessionId}`);
  };

  return {
    async login(persona, pin, language) {
      const user = (await serving.demoUsers()).find((d) => d.persona === persona);
      if (!user || pin !== cfg.demoPin) throw new AuthError("IN_AUTH_001", "invalid demo credentials");
      return issue("customer", user.customer_id, language);
    },
    async agentLogin(pin) {
      if (pin !== cfg.agentPin) throw new AuthError("IN_AUTH_001", "invalid agent credentials");
      return issue("agent", null, "es");
    },
    async verify(token, allow = ["active"]) {
      let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
      try {
        ({ payload } = await jwtVerify(token, cfg.jwtSecret, { algorithms: ["HS256"], currentDate: new Date(now()) }));
      } catch (e) {
        if (e instanceof errors.JWTExpired) throw new AuthError("IN_SESSION_EXPIRED", "session expired");
        throw new AuthError("IN_AUTH_002", "invalid token");
      }
      const sessionId = payload.sid;
      if (typeof sessionId !== "string" || sessionId.length === 0) throw new AuthError("IN_AUTH_002", "token has no session");
      const row = await ops.one<{ status: string; language: Language; role: Role; customer_id: string | null }>(
        "select status, language, role, customer_id from ops.sessions where session_id = $1",
        [sessionId],
      );
      if (!row || !allow.includes(row.status as SessionStatus)) {
        throw new AuthError("IN_SESSION_REVOKED", "session is not active");
      }
      return {
        status: row.status as SessionStatus,
        sessionId,
        role: row.role,
        customerId: row.customer_id ? val(row.customer_id, "jwt") : null,
        language: row.language,
        expiresAt: (payload.exp ?? 0) * 1000,
      };
    },
    revoke: (sessionId) => setStatus(sessionId, "closed"),
    setStatus,
  };
}
