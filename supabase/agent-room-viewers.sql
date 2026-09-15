-- ============================================================
-- Ping — let a teammate watch an agent room in Mission Control
-- Run in Supabase → SQL Editor → Run. Additive: touches no existing row.
--
-- Rooms had exactly one human: owner_user. Everyone else participated only
-- through their agent, so a teammate had no way to see who did what. A viewer
-- is a second kind of human attachment — read-only, and reachable by anyone who
-- already holds the room's invite link, which is no more access than that link
-- already grants (it puts an agent in the room that can read everything).
-- ============================================================

create table if not exists public.agent_group_viewers (
  group_id  uuid not null references public.agent_groups(id) on delete cascade,
  user_id   uuid not null references public.profiles(id)     on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);

alter table public.agent_group_viewers enable row level security;

-- You can see your own watch rows, and drop one to stop watching. Rows are only
-- ever created through watch_agent_room() below, which checks the invite code —
-- so there is deliberately no insert policy.
drop policy if exists agent_group_viewers_read on public.agent_group_viewers;
create policy agent_group_viewers_read on public.agent_group_viewers
  for select using (user_id = auth.uid());

drop policy if exists agent_group_viewers_delete on public.agent_group_viewers;
create policy agent_group_viewers_delete on public.agent_group_viewers
  for delete using (user_id = auth.uid());

-- Start watching a room using its invite link. Honours revocation and expiry
-- exactly as joining does: a link that can no longer add an agent must not be
-- able to add a watcher either.
create or replace function public.watch_agent_room(p_code text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare uid uuid := auth.uid();
        g   record;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'Not authenticated.'); end if;

  select id, name, invite_revoked_at, invite_expires_at into g
  from public.agent_groups where invite_code = p_code;
  if not found then return jsonb_build_object('ok', false, 'error', 'Unknown room link.'); end if;

  if g.invite_revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'That room link has been turned off.');
  end if;
  if g.invite_expires_at is not null and g.invite_expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'That room link has expired.');
  end if;

  insert into public.agent_group_viewers (group_id, user_id)
  values (g.id, uid) on conflict do nothing;

  return jsonb_build_object('ok', true, 'group_id', g.id, 'name', g.name);
end $function$;

-- The roster is part of "who did what", so a viewer needs it too. Still no
-- tokens: this function never returned them.
create or replace function public.list_agent_members(p_group uuid)
returns table(id uuid, name text, last_read timestamptz, joined_at timestamptz)
language sql
security definer
set search_path to 'public'
as $function$
  select m.id, m.name, m.last_read, m.joined_at
  from public.agent_group_members m
  join public.agent_groups g on g.id = m.group_id
  where m.group_id = p_group
    and (
      g.owner_user = auth.uid()
      or exists (
        select 1 from public.agent_group_viewers v
        where v.group_id = p_group and v.user_id = auth.uid()
      )
    )
  order by m.joined_at asc;
$function$;

-- Realtime runs as the signed-in user and obeys RLS, while the timeline comes
-- from an edge function on the service role. Without this a viewer would load
-- the room once and then sit there frozen — reads working, live updates
-- silently blocked, which is the opposite of the point.
drop policy if exists agm_owner_read on public.agent_group_messages;
drop policy if exists agm_room_read on public.agent_group_messages;
create policy agm_room_read on public.agent_group_messages
  for select using (
    exists (
      select 1 from public.agent_groups g
      where g.id = agent_group_messages.group_id and g.owner_user = auth.uid()
    )
    or exists (
      select 1 from public.agent_group_viewers v
      where v.group_id = agent_group_messages.group_id and v.user_id = auth.uid()
    )
  );

-- Signed-in only, enforced at the grant rather than just inside the function.
-- (The body already rejects a null auth.uid() before touching the invite code,
-- so an anonymous caller never learned whether a code existed either way.)
revoke execute on function public.watch_agent_room(text) from anon;
