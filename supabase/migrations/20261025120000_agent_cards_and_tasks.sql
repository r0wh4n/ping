-- ============================================================
-- Ping for Agents — capability discovery and a task lifecycle.
--
-- A2A (v1.0, Linux Foundation) standardises agent-to-agent delegation, but it
-- is point-to-point: client/responder, pairwise. It has no way to express a
-- group, to broadcast that work is available, or to let agents claim it. That
-- is the shape Ping rooms already have, so this adds the two primitives A2A
-- defines (capability cards, task lifecycle) plus the one it cannot (claim),
-- using A2A's own vocabulary so a room maps outward cleanly.
-- ============================================================

-- 1. Agent Cards. ping_members used to return names; a name tells another agent
--    nothing about what you can do.
alter table public.agent_group_members
  add column if not exists card jsonb not null default '{}'::jsonb;

comment on column public.agent_group_members.card is
  'A2A-style capability card: { description, skills[], model }. Self-declared, not verified.';

-- 2. Tasks. A2A's lifecycle verbatim, so a Ping task can be surfaced as an A2A
--    task without translation.
create table if not exists public.agent_tasks (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.agent_groups(id) on delete cascade,
  -- 3. The contextId bridge. A2A carries context along a pairwise chain; here a
  --    whole room IS the context, and every task in it shares this id.
  context_id  uuid not null,
  title       text not null check (char_length(title) between 1 and 200),
  detail      text not null default '' check (char_length(detail) <= 20000),
  state       text not null default 'submitted'
              check (state in ('submitted','working','input-required','completed','failed','canceled')),
  skills      text[] not null default '{}',
  created_by  uuid references public.agent_group_members(id) on delete set null,
  assignee    uuid references public.agent_group_members(id) on delete set null,
  result      text not null default '' check (char_length(result) <= 20000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists agent_tasks_group_idx   on public.agent_tasks (group_id, created_at desc);
create index if not exists agent_tasks_open_idx    on public.agent_tasks (group_id, state) where state = 'submitted';
create index if not exists agent_tasks_context_idx on public.agent_tasks (context_id);

-- Every room gets a stable context id. Existing rooms get one on migration, so
-- the room-to-context mapping is total.
alter table public.agent_groups
  add column if not exists context_id uuid not null default gen_random_uuid();

-- RLS: agents reach tasks through group-api on the service role, and a room owner
-- or watcher may read them from the web. No client writes directly.
alter table public.agent_tasks enable row level security;

drop policy if exists agent_tasks_read on public.agent_tasks;
create policy agent_tasks_read on public.agent_tasks
  for select using (
    exists (select 1 from public.agent_groups g
            where g.id = agent_tasks.group_id and g.owner_user = auth.uid())
    or exists (select 1 from public.agent_group_viewers v
               where v.group_id = agent_tasks.group_id and v.user_id = auth.uid())
  );

-- 4. Claiming, as one atomic statement. Two agents reaching for the same task
--    cannot both win: the WHERE clause only matches an unclaimed, submitted row,
--    so the loser gets zero rows back rather than a silently shared assignment.
create or replace function public.claim_agent_task(p_task uuid, p_member uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare t record;
begin
  update public.agent_tasks
     set assignee = p_member, state = 'working', updated_at = now()
   where id = p_task
     and assignee is null
     and state = 'submitted'
     and group_id = (select group_id from public.agent_group_members where id = p_member)
  returning * into t;

  if not found then
    select * into t from public.agent_tasks where id = p_task;
    if not found then return jsonb_build_object('ok', false, 'error', 'No such task in this room.'); end if;
    return jsonb_build_object('ok', false, 'error',
      'Already taken — this task is ' || t.state ||
      case when t.assignee is null then '' else ' and assigned' end || '.');
  end if;

  return jsonb_build_object('ok', true, 'task_id', t.id, 'state', t.state);
end $function$;

revoke execute on function public.claim_agent_task(uuid, uuid) from anon, authenticated;
