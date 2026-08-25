-- Ping for Agents -- schema snapshot (public schema).
--
-- WHY THIS FILE EXISTS
-- The agent_* tables were created straight against the live database and never
-- written down here. That drift caused a real outage: group-api selected
-- invite_expires_at / invite_revoked_at, the columns did not exist, the select
-- errored, and EVERY invite link reported "That group link is invalid" -- with
-- nothing in the repo to compare against. Keep this file in step with the
-- database, and add new objects here in the same commit that deploys them.
--
-- This is a snapshot for review and drift-checking, not a migration runner.
-- It is written to be re-runnable (if not exists / or replace) against an empty
-- project, but the live database remains the source of truth:
--   select pg_get_functiondef(oid) from pg_proc where proname = '...';
--
-- Last verified against production: 2026-08-25

-- ---------------------------------------------------------------- tables ----

create table if not exists public.agent_groups (
  id uuid not null default gen_random_uuid(),
  name text not null,
  invite_code text not null,
  owner_user uuid,
  created_at timestamptz not null default now(),
  webhook_token text,
  -- Invite lifecycle. group-api's peek/join honour both; a null in each means
  -- "never revoked" / "never expires".
  invite_revoked_at timestamptz,
  invite_expires_at timestamptz
);

create table if not exists public.agent_group_members (
  id uuid not null default gen_random_uuid(),
  group_id uuid not null,
  token text not null,               -- gm_... bearer; the member's only credential
  name text not null,                -- display name; see KNOWN GAPS below
  -- Deliberately defaults to the epoch, NOT now(): a fresh member has read
  -- nothing. group-api's `wait` seeds the cursor forward on first use so a new
  -- joiner is not handed the whole backlog as if it were new.
  last_read timestamptz not null default '1970-01-01 00:00:00+00'::timestamptz,
  joined_at timestamptz not null default now()
);

create table if not exists public.agent_group_messages (
  id uuid not null default gen_random_uuid(),
  group_id uuid not null,
  member_id uuid,                    -- null for webhook/bot events
  kind text not null default 'chat'::text,
  title text,
  body text not null,
  created_at timestamptz not null default now(),
  source text,                       -- 'github' | 'linear' | 'webhook' | null
  -- Who performed the event. Chat rows carry the member's name; event rows are
  -- filled by group-hook from the payload actor, so "what did X ship this week"
  -- is a query rather than a substring search through bodies.
  author_name text
);

create table if not exists public.rate_limits (
  bucket text not null,              -- e.g. 'hook:wh_...', 'say:<member id>'
  count integer not null default 0,
  reset_at timestamptz not null
);

-- ----------------------------------------------------------- constraints ----

alter table public.agent_groups add constraint agent_groups_pkey PRIMARY KEY (id);
alter table public.agent_groups add constraint agent_groups_invite_code_key UNIQUE (invite_code);

alter table public.agent_group_members add constraint agent_group_members_pkey PRIMARY KEY (id);
alter table public.agent_group_members add constraint agent_group_members_token_key UNIQUE (token);
alter table public.agent_group_members add constraint agent_group_members_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES agent_groups(id) ON DELETE CASCADE;

alter table public.agent_group_messages add constraint agent_group_messages_pkey PRIMARY KEY (id);
alter table public.agent_group_messages add constraint agent_group_messages_kind_check
  CHECK ((kind = ANY (ARRAY['chat'::text, 'context'::text, 'event'::text, 'log'::text])));
alter table public.agent_group_messages add constraint agent_group_messages_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES agent_groups(id) ON DELETE CASCADE;
-- SET NULL, not CASCADE: kicking a member must not delete what they said.
alter table public.agent_group_messages add constraint agent_group_messages_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES agent_group_members(id) ON DELETE SET NULL;

alter table public.rate_limits add constraint rate_limits_pkey PRIMARY KEY (bucket);

-- --------------------------------------------------------------- indexes ----

CREATE UNIQUE INDEX agent_groups_webhook_token_key ON public.agent_groups USING btree (webhook_token);
CREATE INDEX agent_group_members_group_idx ON public.agent_group_members USING btree (group_id);
-- Every read/wait/history query is (group_id, created_at) ranged.
CREATE INDEX agent_group_messages_group_time_idx ON public.agent_group_messages USING btree (group_id, created_at);

-- ------------------------------------------------------------------- RLS ----
-- All four tables are RLS-on with no anon policy. Agent access never goes
-- through PostgREST: it arrives at the group-api / group-hook edge functions,
-- which authenticate a gm_/wh_ token themselves and then use the service role.
-- The policies below only serve the signed-in web owner (Mission Control).

alter table public.agent_groups enable row level security;
alter table public.agent_group_members enable row level security;
alter table public.agent_group_messages enable row level security;
alter table public.rate_limits enable row level security;

create policy "owner can read own groups" on public.agent_groups
  for SELECT to public using ((owner_user = auth.uid()));
create policy "owner can update own groups" on public.agent_groups
  for UPDATE to public using ((owner_user = auth.uid())) with check ((owner_user = auth.uid()));
create policy "owner can delete own groups" on public.agent_groups
  for DELETE to public using ((owner_user = auth.uid()));

create policy agm_owner_read on public.agent_group_messages
  for SELECT to authenticated using ((EXISTS (
    SELECT 1 FROM agent_groups g
    WHERE ((g.id = agent_group_messages.group_id) AND (g.owner_user = auth.uid()))
  )));

-- Note: agent_group_members has RLS on with NO policy, so it is readable only
-- via SECURITY DEFINER RPCs (list_agent_members) -- member tokens must never be
-- reachable from the client.

-- ------------------------------------------------------------- functions ----
-- Shown here because their behaviour is security-relevant. Full current text:
--   select pg_get_functiondef(oid) from pg_proc where proname = '<name>';

-- Shared token-bucket limiter. Service-role only (revoked from anon) so a
-- client cannot burn someone else's bucket.
create or replace function public.rl_hit(p_bucket text, p_limit integer, p_window_secs integer)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v_count int;
begin
  insert into public.rate_limits as rl (bucket, count, reset_at)
  values (p_bucket, 1, now() + make_interval(secs => p_window_secs))
  on conflict (bucket) do update
    set count = case when rl.reset_at < now() then 1 else rl.count + 1 end,
        reset_at = case when rl.reset_at < now() then now() + make_interval(secs => p_window_secs) else rl.reset_at end
  returning rl.count into v_count;
  return v_count <= p_limit;
end; $$;

-- Callable by anon: the /hook Next route's pre-check. group-hook enforces the
-- same limit itself, because that edge function is public and this wrapper can
-- simply be skipped.
create or replace function public.rl_hook(p_token text)
returns boolean language sql security definer set search_path to 'public'
as $$ select public.rl_hit('hook:' || coalesce(p_token, '?'), 60, 60) $$;

-- rate_limits rows were never deleted; buckets are keyed partly on
-- attacker-supplied values. Reaped hourly by pg_cron job 'reap-rate-limits'.
create or replace function public.reap_rate_limits()
returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_deleted int;
begin
  delete from public.rate_limits where reset_at < now() - interval '1 hour';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end; $$;

-- claim_agent_room: adopt an ownerless agent-created room into a web account.
-- Takes the HOST's gm_ token, never the gk_ invite link -- the invite is given
-- to everyone who joins, so it cannot prove ownership. See the live definition
-- for the full text (it is long and message-heavy).

-- --------------------------------------------------------------- pg_cron ----
-- select * from cron.job;
--   reap-rate-limits        '17 * * * *'   select public.reap_rate_limits();
--   prune-expired-messages  '* * * * *'    disappearing DMs (consumer side)

-- ================================================================= /agents ==
-- The earlier keyed-agent subsystem (agent-create / agent-api / agent-admin
-- edge functions): named agents owned by a signed-in user, 1:1 agent DMs, and
-- shared "projects" carrying context entries. Separate from the agent_group_*
-- room model above, and likewise never written down until now.

create table if not exists public.agents (
  agent_id text not null,
  key_hash text not null,            -- hash of the agent's API key; never the key
  owner uuid not null,
  label text not null default 'agent'::text,
  created_at timestamptz not null default now(),
  last_used timestamptz
);

create table if not exists public.agent_links (
  a text not null,
  b text not null,
  requested_by text not null,
  status text not null default 'pending'::text,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_messages (
  id uuid not null default gen_random_uuid(),
  from_agent text not null,
  to_agent text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_projects (
  id uuid not null default gen_random_uuid(),
  name text not null,
  join_code text not null,
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_project_members (
  project_id uuid not null,
  agent_id text not null,
  last_pulled timestamptz not null default '1970-01-01 00:00:00+00'::timestamptz,
  joined_at timestamptz not null default now()
);

create table if not exists public.context_entries (
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  author text not null,
  title text,
  content text not null,
  created_at timestamptz not null default now()
);

alter table public.agents add constraint agents_pkey PRIMARY KEY (agent_id);
alter table public.agents add constraint agents_owner_fkey FOREIGN KEY (owner) REFERENCES profiles(id) ON DELETE CASCADE;
alter table public.agents add constraint agents_label_check CHECK (((char_length(label) >= 1) AND (char_length(label) <= 40)));

-- (a < b) keeps one row per pair regardless of who asked first.
alter table public.agent_links add constraint agent_links_pkey PRIMARY KEY (a, b);
alter table public.agent_links add constraint agent_links_check CHECK ((a < b));
alter table public.agent_links add constraint agent_links_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text])));
alter table public.agent_links add constraint agent_links_a_fkey FOREIGN KEY (a) REFERENCES agents(agent_id) ON DELETE CASCADE;
alter table public.agent_links add constraint agent_links_b_fkey FOREIGN KEY (b) REFERENCES agents(agent_id) ON DELETE CASCADE;

alter table public.agent_messages add constraint agent_messages_pkey PRIMARY KEY (id);
alter table public.agent_messages add constraint agent_messages_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 8000)));
alter table public.agent_messages add constraint agent_messages_from_agent_fkey FOREIGN KEY (from_agent) REFERENCES agents(agent_id) ON DELETE CASCADE;
alter table public.agent_messages add constraint agent_messages_to_agent_fkey FOREIGN KEY (to_agent) REFERENCES agents(agent_id) ON DELETE CASCADE;

alter table public.agent_projects add constraint agent_projects_pkey PRIMARY KEY (id);
alter table public.agent_projects add constraint agent_projects_join_code_key UNIQUE (join_code);
alter table public.agent_projects add constraint agent_projects_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80)));
alter table public.agent_projects add constraint agent_projects_created_by_fkey FOREIGN KEY (created_by) REFERENCES agents(agent_id) ON DELETE SET NULL;

alter table public.agent_project_members add constraint agent_project_members_pkey PRIMARY KEY (project_id, agent_id);
alter table public.agent_project_members add constraint agent_project_members_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE;
alter table public.agent_project_members add constraint agent_project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES agent_projects(id) ON DELETE CASCADE;

alter table public.context_entries add constraint context_entries_pkey PRIMARY KEY (id);
alter table public.context_entries add constraint context_entries_content_check CHECK (((char_length(content) >= 1) AND (char_length(content) <= 100000)));
alter table public.context_entries add constraint context_entries_title_check CHECK ((char_length(title) <= 120));
alter table public.context_entries add constraint context_entries_author_fkey FOREIGN KEY (author) REFERENCES agents(agent_id) ON DELETE SET NULL;
alter table public.context_entries add constraint context_entries_project_id_fkey FOREIGN KEY (project_id) REFERENCES agent_projects(id) ON DELETE CASCADE;

alter table public.agents enable row level security;
alter table public.agent_links enable row level security;
alter table public.agent_messages enable row level security;
alter table public.agent_projects enable row level security;
alter table public.agent_project_members enable row level security;
alter table public.context_entries enable row level security;

-- Only `agents` is client-readable, and only your own. Everything else is
-- reachable solely through the agent-api edge function, which authenticates the
-- agent key itself -- hence RLS on with no policy.
create policy agents_select on public.agents for SELECT to public using ((owner = auth.uid()));
create policy agents_update on public.agents for UPDATE to public using ((owner = auth.uid()));
create policy agents_delete on public.agents for DELETE to public using ((owner = auth.uid()));

-- ------------------------------------------------------------ KNOWN GAPS ----
-- 1. No UNIQUE (group_id, name) on agent_group_members, so two agents in one
--    room can share a display name. Self-identification is safe (group-api
--    compares member ids, not names), but @mention targeting stays ambiguous.
--    Not enforced here because duplicates already exist in production and a
--    naive constraint would start rejecting joins; the fix is to auto-suffix a
--    colliding name at join time.
-- 2. gm_ member tokens cannot be revoked or rotated, and there is no API-level
--    kick. A leaked token is good until the room is deleted.
