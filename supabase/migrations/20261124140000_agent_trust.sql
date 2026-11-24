-- Who may direct your agent.
--
-- A room is shared, and anything said in it reaches every agent there. Until
-- now any member could hand any agent work — a task, or just a message that
-- read like an instruction — and nothing distinguished a teammate's request
-- from a stranger's. Each agent now has its own allow-list: the members whose
-- requests and tasks count as work for it. Everyone else is information.
--
-- Only the agent's person can change it, signed in to the Ping app. There is
-- deliberately no way to change it with a member token: an agent that has been
-- talked into something must not be able to widen who can talk to it.
--
-- An agent's person's own other agents (members linked to the same account)
-- are always allowed; that needs no row here.

create table if not exists public.agent_member_trust (
  member_id uuid not null references public.agent_group_members(id) on delete cascade,
  trusted_member_id uuid not null references public.agent_group_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (member_id, trusted_member_id),
  check (member_id <> trusted_member_id)
);
alter table public.agent_member_trust enable row level security;
-- No policies: read and written only by group-api (service role) and the two
-- functions below, which check who is asking.
revoke all on public.agent_member_trust from anon, authenticated;

-- The other members of one of my agents' rooms, and whether each may direct it.
create or replace function public.agent_trust_list(p_member uuid)
  returns table (member_id uuid, name text, role text, allowed boolean, yours boolean)
  language sql security definer set search_path = public stable as $$
  select o.id, o.name, o.role,
         (o.user_id is not null and o.user_id = me.user_id)
           or exists (select 1 from public.agent_member_trust t where t.member_id = me.id and t.trusted_member_id = o.id),
         o.user_id is not null and o.user_id = me.user_id
    from public.agent_group_members me
    join public.agent_group_members o on o.group_id = me.group_id and o.id <> me.id
   where me.id = p_member and me.user_id = auth.uid()
   order by o.joined_at;
$$;

create or replace function public.set_agent_trust(p_member uuid, p_other uuid, p_allow boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'Not signed in.'); end if;
  if not exists (select 1 from public.agent_group_members m
                  where m.id = p_member and m.user_id = uid) then
    return jsonb_build_object('ok', false, 'error', 'Not your agent.');
  end if;
  if not exists (select 1 from public.agent_group_members a
                   join public.agent_group_members b on b.group_id = a.group_id
                  where a.id = p_member and b.id = p_other and b.id <> a.id) then
    return jsonb_build_object('ok', false, 'error', 'That member is not in your agent''s room.');
  end if;
  if p_allow then
    insert into public.agent_member_trust (member_id, trusted_member_id) values (p_member, p_other)
      on conflict do nothing;
  else
    delete from public.agent_member_trust where member_id = p_member and trusted_member_id = p_other;
  end if;
  return jsonb_build_object('ok', true, 'allowed', p_allow);
end $$;

revoke all on function public.agent_trust_list(uuid) from public, anon;
revoke all on function public.set_agent_trust(uuid, uuid, boolean) from public, anon;
grant execute on function public.agent_trust_list(uuid) to authenticated;
grant execute on function public.set_agent_trust(uuid, uuid, boolean) to authenticated;
