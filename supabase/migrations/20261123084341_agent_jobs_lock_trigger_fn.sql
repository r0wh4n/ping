-- The trigger function only ever runs as a trigger. Nobody calls it directly,
-- and the security advisor flagged it as callable by anon and authenticated.
-- (Also written into 20261123084250 for fresh databases; this is the step that
-- production recorded on its own.)
revoke all on function public.notify_agent_job() from public, anon, authenticated;
