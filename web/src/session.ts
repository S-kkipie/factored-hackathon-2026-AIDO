import type { Language } from "./api";

/** Per-tab session (sessionStorage): a demo token lives 15 minutes and never needs to outlive the tab. */
export interface CustomerSession {
  token: string;
  sessionId: string;
  persona: string;
  language: Language;
  expiresAt: number;
}

export interface AgentSession {
  token: string;
  sessionId: string;
  expiresAt: number;
}

function read<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as T & { expiresAt: number };
    return v.expiresAt > Date.now() ? v : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode): the session lives only in memory for this page.
  }
}

let memoryCustomer: CustomerSession | null = null;
let memoryAgent: AgentSession | null = null;

export const session = {
  customer: (): CustomerSession | null => read<CustomerSession>("aido.customer") ?? (memoryCustomer && memoryCustomer.expiresAt > Date.now() ? memoryCustomer : null),
  setCustomer: (s: CustomerSession | null) => {
    memoryCustomer = s;
    write("aido.customer", s);
  },
  agent: (): AgentSession | null => read<AgentSession>("aido.agent") ?? (memoryAgent && memoryAgent.expiresAt > Date.now() ? memoryAgent : null),
  setAgent: (s: AgentSession | null) => {
    memoryAgent = s;
    write("aido.agent", s);
  },
};
