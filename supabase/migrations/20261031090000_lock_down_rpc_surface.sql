-- Take the task-claim off the public API.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default, and PostgREST
-- exposes every function in `public` as /rest/v1/rpc/<name>. So claim_agent_task
-- — the atomic claim that the whole task board rests on — was callable by
-- anyone holding the anon key, which is public by design (it ships in
-- public/ping-notify.mjs). Verified against production: posting two uuids to
-- /rest/v1/rpc/claim_agent_task returned the function's own
-- "No such task in this room", not a permission error.
--
-- What that bought an attacker: group-api checks a gm_ member token before
-- claiming, and this route skips that check entirely. A room member can read
-- task ids from ping_tasks and member ids from ping_members, so any member
-- could claim work *as another member* — defeating the one guarantee the board
-- makes, that a claim is atomic and attributable.
--
-- group-api calls this with the service role, so nothing legitimate is using
-- the public grant.
revoke all on function public.claim_agent_task(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_agent_task(uuid, uuid) to service_role;

-- A DELETE primitive with no caller. It only removes already-expired rows, so
-- the harm is small, but nothing in the app invokes it from a browser and an
-- unauthenticated write endpoint should not exist for the sake of it.
revoke all on function public.prune_expired_messages() from public, anon, authenticated;
grant execute on function public.prune_expired_messages() to service_role;

-- Browser-called by a signed-in person. It already refuses anon by checking
-- auth.uid(), so this is tightening intent rather than closing a hole: the
-- function should not be in anon's surface at all.
revoke all on function public.watch_agent_room(text) from public, anon;
grant execute on function public.watch_agent_room(text) to authenticated, service_role;

-- A trigger function, never an endpoint. It reads NEW, so a direct call errors —
-- but it has no business being reachable over HTTP.
revoke all on function public.notify_agent_room_message() from public, anon, authenticated;
grant execute on function public.notify_agent_room_message() to service_role;

-- Deliberately NOT touched: rl_hook(text). The webhook route calls it with the
-- anon key from the server, and revoking that would silently disable webhook
-- rate limiting (the route fails open). Its exposure is also not an escalation:
-- p_token is the secret webhook token, and anyone holding it can already post
-- into the room, which is strictly more than burning its rate budget. Revisit
-- when that route can carry a service-role key.
