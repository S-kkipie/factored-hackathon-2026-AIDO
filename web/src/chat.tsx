import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, type Interrupt, type TurnView, api, runAgent } from "./api";
import { strings } from "./i18n";
import type { CustomerSession } from "./session";

export interface Line {
  id: string;
  who: "user" | "assistant" | "agent" | "system";
  text: string;
  at: Date;
  view?: TurnView;
}

interface ChatState {
  lines: Line[];
  busy: boolean;
  step: string | null;
  pending: { interrupt: Interrupt; view?: TurnView } | null;
  handoffId: string | null;
  expired: boolean;
  send(text: string): Promise<void>;
  answer(approved: boolean): Promise<void>;
}

const ChatContext = createContext<ChatState | null>(null);

/**
 * Conversation state lives above the routes, so moving between Home, Assistant and My cases keeps the thread,
 * the pending confirmation and the agent poll alive.
 */
export function ChatProvider({ session: s, children }: { session: CustomerSession; children: ReactNode }) {
  const t = strings[s.language];
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [pending, setPending] = useState<ChatState["pending"]>(null);
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const lastAgentId = useRef(0);
  const busyRef = useRef(false);

  const push = useCallback((line: Omit<Line, "id" | "at">) => setLines((ls) => [...ls, { ...line, id: crypto.randomUUID(), at: new Date() }]), []);

  // While a human holds the case, their replies arrive over a plain poll (the agent console is REST).
  useEffect(() => {
    if (!handoffId) return;
    const tick = async () => {
      try {
        for (const m of await api.agentMessages(s.token, lastAgentId.current)) {
          lastAgentId.current = Math.max(lastAgentId.current, m.id);
          push({ who: "agent", text: m.text });
        }
        // The agent closing the case ("resolve") returns the session to the assistant: stop polling and say so.
        if ((await api.session(s.token)).status === "active") {
          setHandoffId(null);
          push({ who: "system", text: t.backToAssistant });
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setExpired(true);
      }
    };
    void tick();
    const timer = setInterval(tick, 3000);
    return () => clearInterval(timer);
  }, [handoffId, s.token, push, t.backToAssistant]);

  const drive = useCallback(
    async (body: Parameters<typeof runAgent>[2]) => {
      busyRef.current = true;
      setBusy(true);
      setStep(null);
      let view: TurnView | undefined;
      try {
        for await (const e of runAgent(s.token, s.sessionId, body)) {
          switch (e.type) {
            case "STEP_STARTED":
              setStep(String(e.stepName));
              break;
            case "STATE_DELTA":
              for (const op of e.delta as { path: string; value: unknown }[]) {
                if (op.path === "/view") {
                  view = op.value as TurnView;
                  if (view.handoffId) setHandoffId(view.handoffId);
                }
                if (op.path === "/outcome" && op.value === "handed_off") setHandoffId((h) => h ?? "—");
              }
              break;
            case "TEXT_MESSAGE_CONTENT":
              push({ who: "assistant", text: String(e.delta), view });
              break;
            case "RUN_FINISHED": {
              const outcome = e.outcome as { type: string; interrupts?: Interrupt[] };
              const it = outcome.type === "interrupt" ? outcome.interrupts?.[0] : undefined;
              setPending(it ? { interrupt: it, view } : null);
              break;
            }
            case "RUN_ERROR":
              push({ who: "system", text: t.runError });
              break;
          }
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) setExpired(true);
        else push({ who: "system", text: t.runError });
      } finally {
        busyRef.current = false;
        setBusy(false);
        setStep(null);
      }
    },
    [s.token, s.sessionId, push, t.runError],
  );

  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || busyRef.current || expired) return;
      setPending(null); // a new message supersedes a pending confirmation on the server too
      push({ who: "user", text: clean });
      await drive({ text: clean });
    },
    [drive, expired, push],
  );

  const answer = useCallback(
    async (approved: boolean) => {
      if (!pending) return;
      const it = pending.interrupt;
      setPending(null);
      push({ who: "user", text: approved ? t.confirm : t.cancel });
      await drive({ resume: { interruptId: it.id, nonce: it.metadata.nonce, approved } });
    },
    [pending, push, drive, t.confirm, t.cancel],
  );

  return (
    <ChatContext.Provider value={{ lines, busy, step, pending, handoffId, expired, send, answer }}>{children}</ChatContext.Provider>
  );
}

export function useChat(): ChatState {
  const c = useContext(ChatContext);
  if (!c) throw new Error("useChat outside ChatProvider");
  return c;
}
