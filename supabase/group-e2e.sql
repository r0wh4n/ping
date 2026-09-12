-- ============================================================
-- Ping — end-to-end encryption for group chats
-- Run in Supabase → SQL Editor → Run. Additive: touches no existing row.
--
-- One random symmetric key per group. Each member gets that key sealed to
-- their profiles.public_key (nacl.box), so the server stores ciphertext only.
-- Message bodies then ride the existing messages.enc flag, exactly like DMs.
-- ============================================================

create table if not exists public.group_keys (
  group_id    uuid not null references public.groups(id)   on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  sealed      text not null,  -- the group key, boxed to user_id's public key
  sender_pub  text not null,  -- sealer's box public key; needed to open `sealed`.
                              -- Stored per-row so a later identity reset by the
                              -- sealer can't orphan everyone else's key.
  created_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);

alter table public.group_keys enable row level security;

-- Any member of the group can read the rows. This leaks nothing: every `sealed`
-- blob is boxed to one member's public key, so only that member can open it.
-- Members need the full list to spot who is still missing a key and seal it for
-- them (a member who had no public_key when the group was created).
drop policy if exists group_keys_read on public.group_keys;
create policy group_keys_read on public.group_keys
  for select using (
    exists (
      select 1 from public.group_members gm
      where gm.group_id = group_keys.group_id and gm.user_id = auth.uid()
    )
  );

-- Any member of the group may hand the key to a member. Insert-only: with no
-- update/delete policy the primary key makes each row write-once, so a member
-- cannot overwrite someone else's key with one they control.
drop policy if exists group_keys_insert on public.group_keys;
create policy group_keys_insert on public.group_keys
  for insert with check (
    exists (
      select 1 from public.group_members gm
      where gm.group_id = group_keys.group_id and gm.user_id = auth.uid()
    )
    and exists (
      select 1 from public.group_members gm2
      where gm2.group_id = group_keys.group_id and gm2.user_id = group_keys.user_id
    )
  );

-- Existing groups keep working: no key row → messages stay plaintext (enc=false)
-- and still render. Ping HQ is joined server-side via join_ping_hq() with no
-- member present to seal a key, so it stays a plaintext community room by design.

-- Polls live in their own table, so the chat bubble being encrypted is not
-- enough — the question and options need the same treatment or they stay
-- server-readable. Same flag shape as messages.enc.
alter table public.polls add column if not exists enc boolean not null default false;

-- ── key rotation on leave ───────────────────────────────────────────────────
-- A member who leaves keeps the copy of the key they were given. RLS stops them
-- reading new rows, but the crypto alone did not — so the group mints a new
-- "epoch" when the member list shrinks, sealed only to who remains.
alter table public.group_keys add column if not exists epoch int not null default 1;

-- Each member now holds one row per epoch: the old ones keep old history
-- readable, the newest one encrypts what gets sent from here.
alter table public.group_keys drop constraint if exists group_keys_pkey;
alter table public.group_keys add constraint group_keys_pkey primary key (group_id, user_id, epoch);

-- The claim table. Two members noticing the same departure would otherwise each
-- mint a different key for epoch N+1 and split the room in half. Inserting here
-- first is the claim, and the primary key means exactly one of them wins; the
-- loser re-reads and adopts the winner's key.
create table if not exists public.group_epochs (
  group_id   uuid not null references public.groups(id) on delete cascade,
  epoch      int  not null,
  minted_by  uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, epoch)
);

alter table public.group_epochs enable row level security;

drop policy if exists group_epochs_read on public.group_epochs;
create policy group_epochs_read on public.group_epochs
  for select using (
    exists (select 1 from public.group_members gm
            where gm.group_id = group_epochs.group_id and gm.user_id = auth.uid())
  );

-- Only a current member may claim an epoch, and only in their own name.
drop policy if exists group_epochs_insert on public.group_epochs;
create policy group_epochs_insert on public.group_epochs
  for insert with check (
    minted_by = auth.uid()
    and exists (select 1 from public.group_members gm
                where gm.group_id = group_epochs.group_id and gm.user_id = auth.uid())
  );
