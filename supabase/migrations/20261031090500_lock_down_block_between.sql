-- block_between(uuid) was reachable by anon over PostgREST, the same way
-- claim_agent_task was: Postgres grants EXECUTE to PUBLIC by default and
-- PostgREST publishes whatever is in `public`. It is only ever called from
-- inside RLS policies on friendships, messages, group_members and
-- scheduled_messages, never from app code, so nothing legitimate loses access.
--
-- This was applied to production directly on 2026-10-30; the file exists so a
-- fresh project built from migrations comes up closed too. The statements are
-- idempotent.
revoke all on function public.block_between(uuid) from public, anon;
grant execute on function public.block_between(uuid) to authenticated, service_role;
