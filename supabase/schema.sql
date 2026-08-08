-- ============================================================
-- Ping — friends-based chat schema
-- Run this in Supabase → SQL Editor → New query → Run.
-- MVP identity = a device-generated uuid (no Supabase Auth yet).
-- RLS is permissive for now; harden with real auth later.
-- ============================================================

create extension if not exists citext;

-- Profiles: one per user, unique @handle -----------------------
create table if not exists public.profiles (
  id          uuid primary key,
  username    citext unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  status      text not null default '',
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

-- Friendships: requester -> addressee -------------------------
create table if not exists public.friendships (
  id          uuid primary key default gen_random_uuid(),
  requester   uuid not null references public.profiles(id) on delete cascade,
  addressee   uuid not null references public.profiles(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at  timestamptz not null default now(),
  unique (requester, addressee)
);
create index if not exists friendships_addressee_idx on public.friendships(addressee, status);
create index if not exists friendships_requester_idx on public.friendships(requester, status);

-- Messages: persistent 1-on-1 DMs -----------------------------
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  sender      uuid not null references public.profiles(id) on delete cascade,
  recipient   uuid not null references public.profiles(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 2000),
  created_at  timestamptz not null default now()
);
create index if not exists messages_pair_idx on public.messages(sender, recipient, created_at);

-- Row Level Security (permissive MVP — see note above) --------
alter table public.profiles    enable row level security;
alter table public.friendships enable row level security;
alter table public.messages    enable row level security;

drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_write  on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_read   on public.profiles for select using (true);
create policy profiles_write  on public.profiles for insert with check (true);
create policy profiles_update on public.profiles for update using (true) with check (true);

drop policy if exists friendships_read   on public.friendships;
drop policy if exists friendships_write  on public.friendships;
drop policy if exists friendships_update on public.friendships;
create policy friendships_read   on public.friendships for select using (true);
create policy friendships_write  on public.friendships for insert with check (true);
create policy friendships_update on public.friendships for update using (true) with check (true);

drop policy if exists messages_read  on public.messages;
drop policy if exists messages_write on public.messages;
create policy messages_read  on public.messages for select using (true);
create policy messages_write on public.messages for insert with check (true);
