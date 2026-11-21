-- Push tokens for the native apps. The Android app can't use web push (no
-- PushManager in its web view), so it registers with Firebase Cloud Messaging and
-- stores the device token here; send-push delivers to these alongside the
-- browsers in push_subscriptions. iOS will use the same table once APNs is set up.
create table if not exists public.device_tokens (
  token text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  platform text not null check (platform in ('android', 'ios')),
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists device_tokens_user_idx on public.device_tokens (user_id);

alter table public.device_tokens enable row level security;
create policy "device_tokens_select" on public.device_tokens for select using (user_id = auth.uid());
create policy "device_tokens_insert" on public.device_tokens for insert with check (user_id = auth.uid());
create policy "device_tokens_update" on public.device_tokens for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "device_tokens_delete" on public.device_tokens for delete using (user_id = auth.uid());
revoke all on public.device_tokens from anon;
grant select, insert, update, delete on public.device_tokens to authenticated;
