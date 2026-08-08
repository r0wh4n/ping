-- ============================================================
-- Ping — switch to real auth (username + password) + scoped RLS
-- Run in Supabase → SQL Editor → Run.
-- WARNING: wipes existing device-based accounts (they can't map to
-- auth users). You approved this reset.
-- ============================================================

-- 1. Clear old device-based data (order respects FKs via cascade).
truncate table public.messages, public.friendships, public.profiles cascade;

-- 2. Tie a profile to a real auth user (id == auth.users.id).
alter table public.profiles
  drop constraint if exists profiles_id_fkey,
  add constraint profiles_id_fkey
    foreign key (id) references auth.users(id) on delete cascade;

-- 3. Replace permissive policies with auth-scoped ones -------------
-- profiles: anyone can read a handle (needed to add friends); you edit only yours
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_write  on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_read   on public.profiles for select using (true);
create policy profiles_insert on public.profiles for insert with check (id = auth.uid());
create policy profiles_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- friendships: only the two people involved can see or change a row
drop policy if exists friendships_read   on public.friendships;
drop policy if exists friendships_write  on public.friendships;
drop policy if exists friendships_update on public.friendships;
create policy friendships_read   on public.friendships for select using (auth.uid() in (requester, addressee));
create policy friendships_insert on public.friendships for insert with check (requester = auth.uid());
create policy friendships_update on public.friendships for update using (auth.uid() in (requester, addressee)) with check (auth.uid() in (requester, addressee));

-- messages: only sender or recipient
drop policy if exists messages_read  on public.messages;
drop policy if exists messages_write on public.messages;
create policy messages_read   on public.messages for select using (auth.uid() in (sender, recipient));
create policy messages_insert on public.messages for insert with check (sender = auth.uid());

-- 4. Account teardown -------------------------------------------------------
-- Either party may delete a friendship row (remove friend / cancel / decline).
drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships for delete using (auth.uid() in (requester, addressee));

-- Full account deletion runs in the `account-delete` edge function: it validates
-- the caller's JWT then admin.deleteUser(uid). The profiles_id_fkey → auth.users
-- ON DELETE CASCADE tears down profile → friendships/messages/push_subscriptions/
-- thread_settings automatically. (No client-side DELETE on profiles needed.)
