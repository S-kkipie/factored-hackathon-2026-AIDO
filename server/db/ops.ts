import { Database } from "bun:sqlite";

const MIGRATIONS = `
  create table if not exists sessions (
    session_id text primary key, customer_id text, role text not null, language text not null,
    created_at text not null, expires_at text not null, status text not null default 'active',
    risk_score real not null default 0, turns integer not null default 0, tokens integer not null default 0);
  create table if not exists disputes (
    dispute_id text primary key, idempotency_key text not null unique, session_id text not null,
    customer_id text not null, transaction_ids text not null, reason text not null, customer_note text,
    note_untrusted integer not null default 1, amount_usd real not null, status text not null, created_at text not null,
    payload_hash text);
  create table if not exists handoffs (
    handoff_id text primary key, idempotency_key text unique, payload_hash text, session_id text not null,
    customer_id text not null, rule_ids text not null, card text not null, status text not null default 'queued',
    created_at text not null, taken_by text, resolved_at text);
  create table if not exists nonces (
    nonce text primary key, session_id text not null, interrupt_id text not null, payload_hash text not null,
    expires_at integer not null, used_at integer);
  create table if not exists audit_events (
    seq integer primary key autoincrement, at text not null, session_id text, kind text not null, rule_id text,
    payload text not null, prev_hash text not null, hash text not null);
  create table if not exists spans (
    span_id text primary key, trace_id text not null, session_id text not null, parent_id text, name text not null,
    started_at text not null, duration_ms real not null, attributes text not null);
  create table if not exists spend (day text primary key, usd real not null default 0);
  create table if not exists rate_events (session_id text not null, at_ms integer not null);
  create index if not exists rate_events_session on rate_events (session_id, at_ms);
  create table if not exists messages (
    id integer primary key autoincrement, session_id text not null, author text not null, text text not null,
    at text not null);
  create index if not exists messages_session on messages (session_id, id);
`;

export function openOps(path: string): Database {
  const db = new Database(path, { create: true });
  if (path !== ":memory:") db.exec("pragma journal_mode = wal");
  db.exec(MIGRATIONS);
  return db;
}
