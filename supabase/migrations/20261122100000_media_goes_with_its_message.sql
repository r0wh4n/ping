-- A photo, video or voice note now goes when its message goes.
--
-- Every way a message disappears is a DELETE on messages: unsending, clearing a
-- chat, a disappearing timer running out (prune_expired_messages), unfriending,
-- and the account itself being deleted (the cascade from profiles). Each of
-- those removed the row and left the file in dm-media for good: on 22 Nov 2026,
-- 147 of 162 files had no message pointing at them. One trigger covers them all.
--
-- Postgres can't remove a Storage file itself (dropping the storage.objects row
-- would orphan the underlying object), so the trigger queues the path and the
-- media-sweep edge function deletes it through the Storage API. Cron calls the
-- function once a minute, and only when the queue has something in it.
create table if not exists public.media_trash (
  path text primary key,
  queued_at timestamptz not null default now()
);
alter table public.media_trash enable row level security; -- no policies: service role only
revoke all on public.media_trash from anon, authenticated;

create or replace function public.queue_message_media() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  insert into public.media_trash (path)
  select p from unnest(array[old.image_path, old.video_path, old.audio_path]) as p
  where p is not null
  on conflict do nothing;
  return old;
end $$;

drop trigger if exists messages_queue_media on public.messages;
create trigger messages_queue_media after delete on public.messages
  for each row execute function public.queue_message_media();

-- A batch for media-sweep to delete. Any queued path that a surviving message
-- still points at is dropped from the queue first, so a file someone can still
-- see is never removed.
-- ponytail: scans messages without an index on the path columns; add one if
-- the table grows past what a full scan per sweep can carry.
create or replace function public.media_trash_batch(n integer default 100) returns setof text
  language plpgsql security definer set search_path = public
as $$
begin
  delete from public.media_trash t
   where exists (select 1 from public.messages m
                  where t.path in (m.image_path, m.video_path, m.audio_path));
  return query select t.path from public.media_trash t order by t.queued_at limit n;
end $$;

-- Calls media-sweep with the internal secret send-push already checks, so no
-- new secret has to be created or copied anywhere.
create or replace function public.call_media_sweep() returns void
  language plpgsql security definer set search_path = vault, public
as $$
declare secret text;
begin
  if not exists (select 1 from public.media_trash) then return; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_webhook_secret';
  perform net.http_post(
    url := 'https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1/media-sweep',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret),
    body := '{}'::jsonb
  );
end $$;

revoke execute on function public.queue_message_media() from public, anon, authenticated;
revoke execute on function public.media_trash_batch(integer) from public, anon, authenticated;
revoke execute on function public.call_media_sweep() from public, anon, authenticated;
grant execute on function public.media_trash_batch(integer) to service_role;

select cron.schedule('sweep-media', '* * * * *', $$ select public.call_media_sweep(); $$);
