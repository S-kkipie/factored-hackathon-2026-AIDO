import { HttpAgent } from "@ag-ui/client";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { ApiError } from "../lib/api";
import { type ChatState, chatReducer, initialChat } from "../lib/chat-state";
import { T } from "../lib/i18n";
import { type StoredCustomer, customerApi } from "../session";

const POLL_MS = 3000;

/**
 * Customer chat over AG-UI (spec 9). One HttpAgent per session: threadId is the JWT session id. Confirmations go
 * back only as `resume` entries with the interrupt's nonce; a typed "sí" is just another message. While a human
 * holds the conversation, agent replies and the session status are polled.
 */
export function useChat(session: StoredCustomer, onExpired: () => void) {
  const [state, dispatch] = useReducer(chatReducer, initialChat);
  const stateRef = useRef<ChatState>(state);
  stateRef.current = state;
  const agentRef = useRef<HttpAgent | null>(null);
  if (!agentRef.current) {
    agentRef.current = new HttpAgent({
      url: "/api/agui/run",
      threadId: session.sessionId,
      headers: { authorization: `Bearer ${session.token}` },
    });
  }
  const t = T[session.language];

  useEffect(() => {
    const sub = agentRef.current!.subscribe({
      onEvent: ({ event }) => {
        dispatch({ type: "event", event });
      },
    });
    return () => sub.unsubscribe();
  }, []);

  const failed = useCallback(async () => {
    dispatch({ type: "failed", message: t.turnFailed });
    try {
      await customerApi.session();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onExpired();
    }
  }, [onExpired, t.turnFailed]);

  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      const s = stateRef.current;
      if (!clean || s.running || s.pending) return;
      const id = crypto.randomUUID();
      dispatch({ type: "user", id, text: clean });
      agentRef.current!.addMessage({ id, role: "user", content: clean });
      try {
        await agentRef.current!.runAgent({ runId: crypto.randomUUID() });
      } catch {
        await failed();
      }
    },
    [failed],
  );

  const answer = useCallback(
    async (approved: boolean) => {
      const p = stateRef.current.pending;
      if (!p || stateRef.current.running) return;
      dispatch({ type: "resume_sent" });
      try {
        await agentRef.current!.runAgent({
          runId: crypto.randomUUID(),
          resume: [
            approved
              ? { interruptId: p.interruptId, status: "resolved", payload: { nonce: p.nonce, approved: true } }
              : { interruptId: p.interruptId, status: "cancelled", payload: { nonce: p.nonce } },
          ],
        });
      } catch {
        await failed();
      }
    },
    [failed],
  );

  useEffect(() => {
    if (!state.handedOff) return;
    let alive = true;
    const tick = async () => {
      try {
        const msgs = await customerApi.chatMessages(stateRef.current.lastAgentMessageId);
        if (alive && msgs.length > 0) dispatch({ type: "agent_messages", messages: msgs });
        const info = await customerApi.session();
        if (alive) dispatch({ type: "session_status", status: info.status, notice: t.backToAssistant });
      } catch (e) {
        if (alive && e instanceof ApiError && e.status === 401) onExpired();
      }
    };
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [state.handedOff, onExpired, t.backToAssistant]);

  return { state, send, answer };
}
