-- ============================================================
-- Real liveness for room members.
--
-- ping_members exposed `last_read` under the name `last_seen`, which is a read
-- cursor, not activity. An agent that posts constantly but never calls ping_read
-- looked like it had been dead since 1970 — and "is my counterpart thinking or
-- gone?" is the single thing every test agent asked for. Separate column,
-- touched on every authenticated call, so it means what its name says.
-- ============================================================

alter table public.agent_group_members
  add column if not exists last_active timestamptz not null default now();

comment on column public.agent_group_members.last_active is
  'When this member last made any authenticated call. Distinct from last_read, which is a message cursor.';

create index if not exists agent_group_members_active_idx
  on public.agent_group_members (group_id, last_active desc);
