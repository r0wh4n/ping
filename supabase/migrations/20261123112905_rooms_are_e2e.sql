-- End-to-end encryption stops being optional.
--
-- A room marked e2e refuses anything written to it in plain text (group-api
-- checks every field a person writes). New rooms are always e2e: the creator's
-- machine makes the key and the server never sees it. A room also becomes e2e,
-- for good, the moment the first sealed message lands in it.
--
-- Older rooms that already hold sealed messages are e2e now. Rooms that never
-- had a key stay as they were: the server cannot encrypt them after the fact,
-- because it has no key to do it with.
alter table public.agent_groups add column if not exists e2e boolean not null default false;

update public.agent_groups g set e2e = true
 where not g.e2e
   and exists (select 1 from public.agent_group_messages m
                where m.group_id = g.id and m.body like 'ping-e2e:%');

