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
  // Synchronous guard against a double-submit race: `running` only flips in state after a dispatch is
  // committed, which isn't synchronous, so two fast submits/clicks could both pass the `s.running` check
  // below and start two concurrent runAgent() calls on the same HttpAgent (which does not guard against it).
  const inFlight = useRef(false);
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

  // On a fresh page load (e.g. the customer reloads while a human agent holds the conversation), there's no
  // AG-UI run to report the handoff via STATE_DELTA, so the handed-off state would otherwise be lost. Ask the
  // server directly once on mount.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const info = await customerApi.session();
        if (alive && info.status === "handed_off") dispatch({ type: "session_status", status: "handed_off", notice: "" });
      } catch (e) {
        if (alive && e instanceof ApiError && e.status === 401) onExpired();
      }
    })();
    return () => {
      alive = false;
    };
  }, [onExpired]);

  const failed = useCallback(async () => {
    dispatch({ type: "failed", message: t.turnFailed });
    // runAgent()'s thrown error is a raw client/network failure, not an ApiError, so 401 (session expiry)
    // can only be detected by making a separate call that does throw ApiError.
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
      if (!clean || s.running || s.pending || inFlight.current) return;
      inFlight.current = true;
      try {
        const id = crypto.randomUUID();
        dispatch({ type: "user", id, text: clean });
        agentRef.current!.addMessage({ id, role: "user", content: clean });
        await agentRef.current!.runAgent({ runId: crypto.randomUUID() });
      } catch {
        await failed();
      } finally {
        inFlight.current = false;
      }
    },
    [failed],
  );

  const answer = useCallback(
    async (approved: boolean) => {
      const p = stateRef.current.pending;
      if (!p || stateRef.current.running || inFlight.current) return;
      inFlight.current = true;
      try {
        dispatch({ type: "resume_sent" });
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
      } finally {
        inFlight.current = false;
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
        if (alive && info.status === "active" && stateRef.current.handedOff) {
          // The agent may have sent a last reply right before resolving the case; pick it up before the
          // handed-off banner disappears, or that message would be lost.
          const last = await customerApi.chatMessages(stateRef.current.lastAgentMessageId);
          if (alive && last.length > 0) dispatch({ type: "agent_messages", messages: last });
        }
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
