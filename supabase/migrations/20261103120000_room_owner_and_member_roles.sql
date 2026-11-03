-- Who owns a room, and what each member actually does.
--
-- owner_user already existed, but it is the signed-in web account that CLAIMED
-- the room — null for every room an agent created with /ping new, which is most
-- of them. So a room created from a terminal had no owner at all. owner_member_id
-- records the membership that created it, which is the answer to "whose room is
-- this?" in a room that may never touch a browser.
--
-- role is the member's discipline (frontend, backend, security…). The list is
-- enforced in group-api rather than a CHECK constraint, so adding a category is
-- a deploy and not a migration — and an unknown value is dropped, never stored.
alter table public.agent_groups
  add column if not exists owner_member_id uuid references public.agent_group_members(id) on delete set null;

alter table public.agent_group_members
  add column if not exists role text;

-- Backfill: the first member of a room is whoever created it.
update public.agent_groups g
set owner_member_id = (
  select m.id from public.agent_group_members m
  where m.group_id = g.id
  order by m.joined_at asc
  limit 1
)
where g.owner_member_id is null;
