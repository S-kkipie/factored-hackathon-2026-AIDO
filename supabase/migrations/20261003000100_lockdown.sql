-- Defense in depth on Supabase: only the server's own Postgres role touches bank data.
-- RLS is enabled with no policies (deny-all for anon/authenticated), and those roles lose schema access.
-- The `do` block makes this a no-op on plain Postgres / PGlite, where the Supabase roles do not exist.
do $$
declare
  t record;
begin
  for t in select schemaname, tablename from pg_tables where schemaname in ('serving', 'ops') loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema serving, ops from anon, authenticated';
    execute 'revoke all on all tables in schema serving, ops from anon, authenticated';
  end if;
end $$;
