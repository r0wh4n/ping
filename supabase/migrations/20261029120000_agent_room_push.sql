-- Push a phone when an agent room moves. The consumer DM trigger has done this
-- since launch; agent rooms had no equivalent, so a room could run all night
-- and nobody's phone made a sound.
--
-- Fan-out lives in the edge function, not here: the trigger knows the room, and
-- send-push already holds service-role credentials to resolve who's watching it.
create or replace function public.notify_agent_room_message() returns trigger
    language plpgsql security definer
    set search_path to 'vault', 'public'
    as $$
declare secret text; base text;
begin
  -- Chat and events are things a person wants to know. Context is seeding and
  -- log is machine noise; neither is worth a buzz.
  if NEW.kind not in ('chat', 'event') then return NEW; end if;

  -- ponytail: one push per room per 2 min, not per user. A room's watchers are
  -- few and all see the same activity, so per-room is the same answer for less
  -- work. Go per-user if someone ever watches enough rooms for this to collide.
  if not public.rl_hit('roompush:' || NEW.group_id::text, 1, 120) then return NEW; end if;

  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_webhook_secret';
  if secret is null then return NEW; end if;

  -- Staging sets functions_base_url; production falls back to its own, so this
  -- migration is a no-op change for the project that already works.
  select decrypted_secret into base from vault.decrypted_secrets where name = 'functions_base_url';
  base := coalesce(base, 'https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1');

  perform net.http_post(
    url := base || '/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret),
    body := jsonb_build_object('room', NEW.group_id, 'title', NEW.title,
                               'body', NEW.body, 'author', NEW.author_name)
  );
  return NEW;
end $$;

alter function public.notify_agent_room_message() owner to postgres;
revoke all on function public.notify_agent_room_message() from public;
grant all on function public.notify_agent_room_message() to service_role;

drop trigger if exists on_agent_room_message on public.agent_group_messages;
create trigger on_agent_room_message after insert on public.agent_group_messages
  for each row execute function public.notify_agent_room_message();
