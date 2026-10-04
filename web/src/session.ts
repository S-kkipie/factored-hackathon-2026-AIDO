import { createApi, type Language } from "./lib/api";

export interface StoredCustomer {
  token: string;
  sessionId: string;
  language: Language;
  persona: string;
  expiresAt: number;
}

export interface StoredAgent {
  token: string;
  sessionId: string;
  expiresAt: number;
}

const KEYS = { customer: "aido.customer", agent: "aido.agent" } as const;

function read<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode, blocked): the session lasts until reload.
  }
}

function clear(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing stored to clear.
  }
}

export const readCustomer = () => read<StoredCustomer>(KEYS.customer);
export const writeCustomer = (s: StoredCustomer) => write(KEYS.customer, s);
export const clearCustomer = () => clear(KEYS.customer);
export const readAgent = () => read<StoredAgent>(KEYS.agent);
export const writeAgent = (s: StoredAgent) => write(KEYS.agent, s);
export const clearAgent = () => clear(KEYS.agent);

export const customerApi = createApi({ token: () => readCustomer()?.token ?? null });
export const agentApi = createApi({ token: () => readAgent()?.token ?? null });
