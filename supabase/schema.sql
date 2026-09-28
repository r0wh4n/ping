-- ============================================================
-- Ping — the complete database schema.
--
-- Generated from production, not hand-written. Every table, RLS policy,
-- function and index the app actually relies on is here: run this against a
-- fresh Supabase project and Ping will stand up.
--
-- Regenerate after any schema change:
--
--   supabase db dump --project-ref <project-ref> -f supabase/schema.sql
--
-- (needs the Supabase CLI logged in, and Docker running for pg_dump.)
--
-- This file replaces a hand-written one that had drifted badly — it described
-- three tables while production had twenty-nine, so a fresh clone could not run
-- the app at all. The other .sql files in this directory are the historical
-- steps that got production to this point and are kept as a record; none of
-- them is needed for a new setup.
-- ============================================================




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."block_between"("other" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists(
    select 1 from public.blocks
    where (blocker = auth.uid() and blocked = other)
       or (blocker = other and blocked = auth.uid())
  );
$$;


ALTER FUNCTION "public"."block_between"("other" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_agent_room"("p_code" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  tok text; g record; m record; uid uuid := auth.uid(); host_id uuid;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'Not authenticated.');
  end if;

  -- Name the mistake precisely rather than failing with a generic error.
  if p_code ~ 'gk_[A-Za-z0-9_-]+' then
    return jsonb_build_object('ok', false, 'error',
      'That is the room''s join link, which every member has, so it cannot prove ownership. Paste the claim link instead - run /ping claim in the agent that created the room.');
  end if;

  tok := substring(p_code from 'gm_[A-Za-z0-9_-]+');
  if tok is null then
    return jsonb_build_object('ok', false, 'error',
      'Paste the room''s claim link. Run /ping claim in the agent that created the room to print it.');
  end if;

  select * into m from public.agent_group_members where token = tok;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'That claim link is not valid.');
  end if;

  select id, name, owner_user into g from public.agent_groups where id = m.group_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'That room no longer exists.');
  end if;

  -- Every member holds a gm_ token, so holding one is not enough: it must be the
  -- room's first member, i.e. the agent that created it.
  select id into host_id
    from public.agent_group_members
   where group_id = g.id
   order by joined_at asc, id asc
   limit 1;

  if host_id is null or host_id <> m.id then
    return jsonb_build_object('ok', false, 'error',
      'Only the agent that created this room can adopt it. Ask whoever created it to run /ping claim.');
  end if;

  if g.owner_user is not null and g.owner_user <> uid then
    return jsonb_build_object('ok', false, 'error', 'This room is already owned by someone else.');
  end if;

  if g.owner_user is null then
    update public.agent_groups set owner_user = uid where id = g.id;
  end if;

  return jsonb_build_object('ok', true, 'group_id', g.id, 'name', g.name);
end
$$;


ALTER FUNCTION "public"."claim_agent_room"("p_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_group"("name" "text", "members" "uuid"[]) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare gid uuid;
begin
  if auth.uid() is null then raise exception 'auth required'; end if;
  if char_length(coalesce(name,'')) < 1 or char_length(name) > 50 then
    raise exception 'invalid group name';
  end if;
  insert into public.groups(name, created_by) values (create_group.name, auth.uid()) returning id into gid;
  insert into public.group_members(group_id, user_id) values (gid, auth.uid());
  insert into public.group_members(group_id, user_id)
    select gid, m from unnest(members) as m
    where m <> auth.uid()
      and exists (
        select 1 from public.friendships f where f.status = 'accepted'
        and ((f.requester = auth.uid() and f.addressee = m) or (f.requester = m and f.addressee = auth.uid()))
      )
  on conflict do nothing;
  return gid;
end $$;


ALTER FUNCTION "public"."create_group"("name" "text", "members" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_agent_room"("p_group" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'Not authenticated.'); end if;
  if not exists (select 1 from public.agent_groups where id = p_group and owner_user = uid) then
    return jsonb_build_object('ok', false, 'error', 'Not your room.');
  end if;
  delete from public.agent_group_messages where group_id = p_group;
  delete from public.agent_group_members where group_id = p_group;
  delete from public.agent_groups where id = p_group;
  return jsonb_build_object('ok', true);
end $$;


ALTER FUNCTION "public"."delete_agent_room"("p_group" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deliver_scheduled"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare n integer;
begin
  with due as (
    delete from public.scheduled_messages where scheduled_at <= now()
    returning sender, recipient, body, enc, reply_to
  )
  insert into public.messages (sender, recipient, body, enc, reply_to, created_at)
  select d.sender, d.recipient, d.body, d.enc, d.reply_to, now()
  from due d
  where exists (select 1 from public.profiles ps where ps.id = d.sender)
    and exists (select 1 from public.profiles pr where pr.id = d.recipient)
    and not exists (
      select 1 from public.blocks b
      where (b.blocker = d.recipient and b.blocked = d.sender)
         or (b.blocker = d.sender and b.blocked = d.recipient)
    );
  get diagnostics n = row_count;
  return n;
end $$;


ALTER FUNCTION "public"."deliver_scheduled"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_block"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if exists (
    select 1 from public.blocks
    where (blocker = new.sender and blocked = new.recipient)
       or (blocker = new.recipient and blocked = new.sender)
  ) then
    raise exception 'blocked: you cannot message this user' using errcode = 'check_violation';
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."enforce_block"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_friend_block"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if exists (
    select 1 from public.blocks
    where (blocker = new.requester and blocked = new.addressee)
       or (blocker = new.addressee and blocked = new.requester)
  ) then
    raise exception 'blocked: cannot send a request to this user' using errcode = 'check_violation';
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."enforce_friend_block"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_friend_rate"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare recent int;
begin
  select count(*) into recent from public.friendships
   where requester = new.requester and created_at > now() - interval '1 hour';
  if recent >= 40 then
    raise exception 'rate_limited: too many requests, try again later' using errcode = 'check_violation';
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."enforce_friend_rate"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_message_rate"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare recent int;
begin
  select count(*) into recent from public.messages
   where sender = new.sender and created_at > now() - interval '10 seconds';
  if recent >= 20 then
    raise exception 'rate_limited: slow down for a moment' using errcode = 'check_violation';
  end if;
  return new;
end $$;


ALTER FUNCTION "public"."enforce_message_rate"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_group_member"("g" "uuid", "u" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists(select 1 from public.group_members where group_id = g and user_id = u);
$$;


ALTER FUNCTION "public"."is_group_member"("g" "uuid", "u" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."join_ping_hq"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare hq uuid := '0e1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b';
begin
  if auth.uid() is null then return; end if;
  insert into public.group_members (group_id, user_id)
  select hq, auth.uid()
  where not exists (
    select 1 from public.group_members where group_id = hq and user_id = auth.uid()
  );
end;
$$;


ALTER FUNCTION "public"."join_ping_hq"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."kick_agent_member"("p_group" "uuid", "p_member" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'Not authenticated.'); end if;
  if not exists (select 1 from public.agent_groups where id = p_group and owner_user = uid) then
    return jsonb_build_object('ok', false, 'error', 'Not your room.');
  end if;
  delete from public.agent_group_members where id = p_member and group_id = p_group;
  return jsonb_build_object('ok', true);
end $$;


ALTER FUNCTION "public"."kick_agent_member"("p_group" "uuid", "p_member" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."list_agent_members"("p_group" "uuid") RETURNS TABLE("id" "uuid", "name" "text", "last_read" timestamp with time zone, "joined_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select m.id, m.name, m.last_read, m.joined_at
  from public.agent_group_members m
  join public.agent_groups g on g.id = m.group_id
  where m.group_id = p_group
    and (
      g.owner_user = auth.uid()
      or exists (
        select 1 from public.agent_group_viewers v
        where v.group_id = p_group and v.user_id = auth.uid()
      )
    )
  order by m.joined_at asc;
$$;


ALTER FUNCTION "public"."list_agent_members"("p_group" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_new_message"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'vault', 'public'
    AS $$
declare secret text;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_webhook_secret';
  perform net.http_post(
    url := 'https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret),
    body := jsonb_build_object('recipient', NEW.recipient, 'sender', NEW.sender,
                               'body', case when NEW.enc then '' else NEW.body end)
  );
  return NEW;
end $$;


ALTER FUNCTION "public"."notify_new_message"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_expired_messages"() RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ delete from public.messages where expire_at is not null and expire_at < now(); $$;


ALTER FUNCTION "public"."prune_expired_messages"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."push_secrets"() RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'vault', 'public'
    AS $$
  select jsonb_build_object(
    'webhook',       (select decrypted_secret from vault.decrypted_secrets where name = 'push_webhook_secret'),
    'vapid_private', (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_private_key')
  );
$$;


ALTER FUNCTION "public"."push_secrets"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reap_rate_limits"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_deleted int;
begin
  -- 1h grace so an in-flight window is never yanked out from under rl_hit.
  delete from public.rate_limits where reset_at < now() - interval '1 hour';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;


ALTER FUNCTION "public"."reap_rate_limits"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rl_hit"("p_bucket" "text", "p_limit" integer, "p_window_secs" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_count int;
begin
  insert into public.rate_limits as rl (bucket, count, reset_at)
  values (p_bucket, 1, now() + make_interval(secs => p_window_secs))
  on conflict (bucket) do update
    set count = case when rl.reset_at < now() then 1 else rl.count + 1 end,
        reset_at = case when rl.reset_at < now() then now() + make_interval(secs => p_window_secs) else rl.reset_at end
  returning rl.count into v_count;
  return v_count <= p_limit;
end;
$$;


ALTER FUNCTION "public"."rl_hit"("p_bucket" "text", "p_limit" integer, "p_window_secs" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rl_hook"("p_token" "text") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ select public.rl_hit('hook:' || coalesce(p_token, '?'), 60, 60) $$;


ALTER FUNCTION "public"."rl_hook"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unread_counts"() RETURNS TABLE("other" "uuid", "n" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select m.sender as other, count(*)::bigint as n
  from public.messages m
  left join public.thread_reads r on r.owner = auth.uid() and r.other = m.sender
  where m.recipient = auth.uid()
    and m.created_at > coalesce(r.last_read, 'epoch'::timestamptz)
  group by m.sender;
$$;


ALTER FUNCTION "public"."unread_counts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."watch_agent_room"("p_code" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare uid uuid := auth.uid();
        g   record;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'Not authenticated.'); end if;

  select id, name, invite_revoked_at, invite_expires_at into g
  from public.agent_groups where invite_code = p_code;
  if not found then return jsonb_build_object('ok', false, 'error', 'Unknown room link.'); end if;

  if g.invite_revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'That room link has been turned off.');
  end if;
  if g.invite_expires_at is not null and g.invite_expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'That room link has expired.');
  end if;

  insert into public.agent_group_viewers (group_id, user_id)
  values (g.id, uid) on conflict do nothing;

  return jsonb_build_object('ok', true, 'group_id', g.id, 'name', g.name);
end $$;


ALTER FUNCTION "public"."watch_agent_room"("p_code" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."agent_group_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "token" "text" NOT NULL,
    "name" "text" NOT NULL,
    "last_read" timestamp with time zone DEFAULT '1970-01-01 00:00:00+00'::timestamp with time zone NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agent_group_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_group_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "member_id" "uuid",
    "kind" "text" DEFAULT 'chat'::"text" NOT NULL,
    "title" "text",
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text",
    "author_name" "text",
    CONSTRAINT "agent_group_messages_kind_check" CHECK (("kind" = ANY (ARRAY['chat'::"text", 'context'::"text", 'event'::"text", 'log'::"text"])))
);


ALTER TABLE "public"."agent_group_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_group_viewers" (
    "group_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agent_group_viewers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "invite_code" "text" NOT NULL,
    "owner_user" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "webhook_token" "text",
    "invite_revoked_at" timestamp with time zone,
    "invite_expires_at" timestamp with time zone
);


ALTER TABLE "public"."agent_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_links" (
    "a" "text" NOT NULL,
    "b" "text" NOT NULL,
    "requested_by" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agent_links_check" CHECK (("a" < "b")),
    CONSTRAINT "agent_links_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text"])))
);


ALTER TABLE "public"."agent_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_agent" "text" NOT NULL,
    "to_agent" "text" NOT NULL,
    "body" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agent_messages_body_check" CHECK ((("char_length"("body") >= 1) AND ("char_length"("body") <= 8000)))
);


ALTER TABLE "public"."agent_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_project_members" (
    "project_id" "uuid" NOT NULL,
    "agent_id" "text" NOT NULL,
    "last_pulled" timestamp with time zone DEFAULT '1970-01-01 00:00:00+00'::timestamp with time zone NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agent_project_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_projects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "join_code" "text" NOT NULL,
    "created_by" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "agent_projects_name_check" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 80)))
);


ALTER TABLE "public"."agent_projects" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agents" (
    "agent_id" "text" NOT NULL,
    "key_hash" "text" NOT NULL,
    "owner" "uuid" NOT NULL,
    "label" "text" DEFAULT 'agent'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used" timestamp with time zone,
    CONSTRAINT "agents_label_check" CHECK ((("char_length"("label") >= 1) AND ("char_length"("label") <= 40)))
);


ALTER TABLE "public"."agents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."blocks" (
    "blocker" "uuid" NOT NULL,
    "blocked" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."blocks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."context_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "author" "text" NOT NULL,
    "title" "text",
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "context_entries_content_check" CHECK ((("char_length"("content") >= 1) AND ("char_length"("content") <= 100000))),
    CONSTRAINT "context_entries_title_check" CHECK (("char_length"("title") <= 120))
);


ALTER TABLE "public"."context_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."friendships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "requester" "uuid" NOT NULL,
    "addressee" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "friendships_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'declined'::"text"])))
);


ALTER TABLE "public"."friendships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."group_epochs" (
    "group_id" "uuid" NOT NULL,
    "epoch" integer NOT NULL,
    "minted_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."group_epochs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."group_keys" (
    "group_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "sealed" "text" NOT NULL,
    "sender_pub" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "epoch" integer DEFAULT 1 NOT NULL
);


ALTER TABLE "public"."group_keys" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."group_members" (
    "group_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."group_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."groups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "groups_name_check" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 50)))
);


ALTER TABLE "public"."groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."message_reactions" (
    "message_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "emoji" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "message_reactions_emoji_check" CHECK ((("char_length"("emoji") >= 1) AND ("char_length"("emoji") <= 12)))
);


ALTER TABLE "public"."message_reactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sender" "uuid" NOT NULL,
    "recipient" "uuid",
    "body" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reply_to" "uuid",
    "image_path" "text",
    "audio_path" "text",
    "audio_secs" integer,
    "group_id" "uuid",
    "enc" boolean DEFAULT false NOT NULL,
    "poll_id" "uuid",
    "ephemeral" boolean DEFAULT false NOT NULL,
    "video_path" "text",
    "opened_at" timestamp with time zone,
    "views" integer DEFAULT 0 NOT NULL,
    "saved" boolean DEFAULT false NOT NULL,
    "expire_at" timestamp with time zone,
    CONSTRAINT "messages_content_check" CHECK ((("char_length"("body") <= 2000) AND (("char_length"("body") >= 1) OR ("image_path" IS NOT NULL) OR ("audio_path" IS NOT NULL)))),
    CONSTRAINT "messages_target_check" CHECK (((("recipient" IS NOT NULL) AND ("group_id" IS NULL)) OR (("recipient" IS NULL) AND ("group_id" IS NOT NULL))))
);


ALTER TABLE "public"."messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."poll_votes" (
    "poll_id" "uuid" NOT NULL,
    "voter" "uuid" NOT NULL,
    "choice" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."poll_votes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."polls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "group_id" "uuid" NOT NULL,
    "creator" "uuid" NOT NULL,
    "question" "text" NOT NULL,
    "options" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "enc" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."polls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "username" "public"."citext" NOT NULL,
    "status" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen" timestamp with time zone DEFAULT "now"() NOT NULL,
    "public_key" "text",
    CONSTRAINT "profiles_username_check" CHECK (("username" OPERATOR("public".~) '^[a-z0-9_]{3,20}$'::"public"."citext"))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."push_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "endpoint" "text" NOT NULL,
    "p256dh" "text" NOT NULL,
    "auth" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."push_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rate_limits" (
    "bucket" "text" NOT NULL,
    "count" integer DEFAULT 0 NOT NULL,
    "reset_at" timestamp with time zone NOT NULL
);


ALTER TABLE "public"."rate_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "reporter" "uuid" NOT NULL,
    "reported" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reports_reason_check" CHECK ((("char_length"("reason") >= 1) AND ("char_length"("reason") <= 500)))
);


ALTER TABLE "public"."reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scheduled_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sender" "uuid" NOT NULL,
    "recipient" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "enc" boolean DEFAULT false NOT NULL,
    "reply_to" "uuid",
    "scheduled_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."scheduled_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."signup_attempts" (
    "ip" "text" NOT NULL,
    "at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."signup_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."thread_reads" (
    "owner" "uuid" NOT NULL,
    "other" "uuid" NOT NULL,
    "last_read" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."thread_reads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."thread_settings" (
    "user_a" "uuid" NOT NULL,
    "user_b" "uuid" NOT NULL,
    "clear_after_seconds" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pinned_message_id" "text",
    CONSTRAINT "thread_settings_check" CHECK (("user_a" < "user_b"))
);


ALTER TABLE "public"."thread_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_keys" (
    "user_id" "uuid" NOT NULL,
    "encrypted_private_key" "text" NOT NULL,
    "key_salt" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_keys" OWNER TO "postgres";


ALTER TABLE ONLY "public"."agent_group_members"
    ADD CONSTRAINT "agent_group_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_group_members"
    ADD CONSTRAINT "agent_group_members_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."agent_group_messages"
    ADD CONSTRAINT "agent_group_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_group_viewers"
    ADD CONSTRAINT "agent_group_viewers_pkey" PRIMARY KEY ("group_id", "user_id");



ALTER TABLE ONLY "public"."agent_groups"
    ADD CONSTRAINT "agent_groups_invite_code_key" UNIQUE ("invite_code");



ALTER TABLE ONLY "public"."agent_groups"
    ADD CONSTRAINT "agent_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_links"
    ADD CONSTRAINT "agent_links_pkey" PRIMARY KEY ("a", "b");



ALTER TABLE ONLY "public"."agent_messages"
    ADD CONSTRAINT "agent_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_project_members"
    ADD CONSTRAINT "agent_project_members_pkey" PRIMARY KEY ("project_id", "agent_id");



ALTER TABLE ONLY "public"."agent_projects"
    ADD CONSTRAINT "agent_projects_join_code_key" UNIQUE ("join_code");



ALTER TABLE ONLY "public"."agent_projects"
    ADD CONSTRAINT "agent_projects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agents"
    ADD CONSTRAINT "agents_pkey" PRIMARY KEY ("agent_id");



ALTER TABLE ONLY "public"."blocks"
    ADD CONSTRAINT "blocks_pkey" PRIMARY KEY ("blocker", "blocked");



ALTER TABLE ONLY "public"."context_entries"
    ADD CONSTRAINT "context_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_requester_addressee_key" UNIQUE ("requester", "addressee");



ALTER TABLE ONLY "public"."group_epochs"
    ADD CONSTRAINT "group_epochs_pkey" PRIMARY KEY ("group_id", "epoch");



ALTER TABLE ONLY "public"."group_keys"
    ADD CONSTRAINT "group_keys_pkey" PRIMARY KEY ("group_id", "user_id", "epoch");



ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "group_members_pkey" PRIMARY KEY ("group_id", "user_id");



ALTER TABLE ONLY "public"."groups"
    ADD CONSTRAINT "groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("message_id", "user_id");



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."poll_votes"
    ADD CONSTRAINT "poll_votes_pkey" PRIMARY KEY ("poll_id", "voter");



ALTER TABLE ONLY "public"."polls"
    ADD CONSTRAINT "polls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_username_key" UNIQUE ("username");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_endpoint_key" UNIQUE ("endpoint");



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rate_limits"
    ADD CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("bucket");



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scheduled_messages"
    ADD CONSTRAINT "scheduled_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."thread_reads"
    ADD CONSTRAINT "thread_reads_pkey" PRIMARY KEY ("owner", "other");



ALTER TABLE ONLY "public"."thread_settings"
    ADD CONSTRAINT "thread_settings_pkey" PRIMARY KEY ("user_a", "user_b");



ALTER TABLE ONLY "public"."user_keys"
    ADD CONSTRAINT "user_keys_pkey" PRIMARY KEY ("user_id");



CREATE INDEX "agent_group_members_group_idx" ON "public"."agent_group_members" USING "btree" ("group_id");



CREATE INDEX "agent_group_messages_group_time_idx" ON "public"."agent_group_messages" USING "btree" ("group_id", "created_at");



CREATE UNIQUE INDEX "agent_groups_webhook_token_key" ON "public"."agent_groups" USING "btree" ("webhook_token");



CREATE INDEX "agent_messages_to_idx" ON "public"."agent_messages" USING "btree" ("to_agent", "created_at");



CREATE INDEX "agents_owner_idx" ON "public"."agents" USING "btree" ("owner");



CREATE INDEX "context_entries_project_idx" ON "public"."context_entries" USING "btree" ("project_id", "created_at");



CREATE INDEX "friendships_addressee_idx" ON "public"."friendships" USING "btree" ("addressee", "status");



CREATE INDEX "friendships_requester_idx" ON "public"."friendships" USING "btree" ("requester", "status");



CREATE INDEX "messages_group_idx" ON "public"."messages" USING "btree" ("group_id", "created_at");



CREATE INDEX "messages_pair_idx" ON "public"."messages" USING "btree" ("sender", "recipient", "created_at");



CREATE INDEX "push_subscriptions_user_idx" ON "public"."push_subscriptions" USING "btree" ("user_id");



CREATE INDEX "scheduled_messages_due_idx" ON "public"."scheduled_messages" USING "btree" ("scheduled_at");



CREATE INDEX "signup_attempts_ip_idx" ON "public"."signup_attempts" USING "btree" ("ip", "at");



CREATE OR REPLACE TRIGGER "on_message_insert" AFTER INSERT ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."notify_new_message"();



CREATE OR REPLACE TRIGGER "trg_friend_block" BEFORE INSERT ON "public"."friendships" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_friend_block"();



CREATE OR REPLACE TRIGGER "trg_friend_rate" BEFORE INSERT ON "public"."friendships" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_friend_rate"();



CREATE OR REPLACE TRIGGER "trg_message_block" BEFORE INSERT ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_block"();



CREATE OR REPLACE TRIGGER "trg_message_rate" BEFORE INSERT ON "public"."messages" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_message_rate"();



ALTER TABLE ONLY "public"."agent_group_members"
    ADD CONSTRAINT "agent_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."agent_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_group_messages"
    ADD CONSTRAINT "agent_group_messages_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."agent_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_group_messages"
    ADD CONSTRAINT "agent_group_messages_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "public"."agent_group_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agent_group_viewers"
    ADD CONSTRAINT "agent_group_viewers_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."agent_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_group_viewers"
    ADD CONSTRAINT "agent_group_viewers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_links"
    ADD CONSTRAINT "agent_links_a_fkey" FOREIGN KEY ("a") REFERENCES "public"."agents"("agent_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_links"
    ADD CONSTRAINT "agent_links_b_fkey" FOREIGN KEY ("b") REFERENCES "public"."agents"("agent_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_messages"
    ADD CONSTRAINT "agent_messages_from_agent_fkey" FOREIGN KEY ("from_agent") REFERENCES "public"."agents"("agent_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_messages"
    ADD CONSTRAINT "agent_messages_to_agent_fkey" FOREIGN KEY ("to_agent") REFERENCES "public"."agents"("agent_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_project_members"
    ADD CONSTRAINT "agent_project_members_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("agent_id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_project_members"
    ADD CONSTRAINT "agent_project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."agent_projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."agent_projects"
    ADD CONSTRAINT "agent_projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."agents"("agent_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."agents"
    ADD CONSTRAINT "agents_owner_fkey" FOREIGN KEY ("owner") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."blocks"
    ADD CONSTRAINT "blocks_blocked_fkey" FOREIGN KEY ("blocked") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."blocks"
    ADD CONSTRAINT "blocks_blocker_fkey" FOREIGN KEY ("blocker") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."context_entries"
    ADD CONSTRAINT "context_entries_author_fkey" FOREIGN KEY ("author") REFERENCES "public"."agents"("agent_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."context_entries"
    ADD CONSTRAINT "context_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."agent_projects"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_addressee_fkey" FOREIGN KEY ("addressee") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_requester_fkey" FOREIGN KEY ("requester") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."group_epochs"
    ADD CONSTRAINT "group_epochs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."group_epochs"
    ADD CONSTRAINT "group_epochs_minted_by_fkey" FOREIGN KEY ("minted_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."group_keys"
    ADD CONSTRAINT "group_keys_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."group_keys"
    ADD CONSTRAINT "group_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."group_members"
    ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."groups"
    ADD CONSTRAINT "groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."message_reactions"
    ADD CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_recipient_fkey" FOREIGN KEY ("recipient") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_reply_to_fkey" FOREIGN KEY ("reply_to") REFERENCES "public"."messages"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."messages"
    ADD CONSTRAINT "messages_sender_fkey" FOREIGN KEY ("sender") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."poll_votes"
    ADD CONSTRAINT "poll_votes_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_reported_fkey" FOREIGN KEY ("reported") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reports"
    ADD CONSTRAINT "reports_reporter_fkey" FOREIGN KEY ("reporter") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."thread_reads"
    ADD CONSTRAINT "thread_reads_other_fkey" FOREIGN KEY ("other") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."thread_reads"
    ADD CONSTRAINT "thread_reads_owner_fkey" FOREIGN KEY ("owner") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."thread_settings"
    ADD CONSTRAINT "thread_settings_user_a_fkey" FOREIGN KEY ("user_a") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."thread_settings"
    ADD CONSTRAINT "thread_settings_user_b_fkey" FOREIGN KEY ("user_b") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_keys"
    ADD CONSTRAINT "user_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE "public"."agent_group_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_group_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_group_viewers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_group_viewers_delete" ON "public"."agent_group_viewers" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "agent_group_viewers_read" ON "public"."agent_group_viewers" FOR SELECT USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."agent_groups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_project_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agent_projects" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."agents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agents_delete" ON "public"."agents" FOR DELETE USING (("owner" = "auth"."uid"()));



CREATE POLICY "agents_select" ON "public"."agents" FOR SELECT USING (("owner" = "auth"."uid"()));



CREATE POLICY "agents_update" ON "public"."agents" FOR UPDATE USING (("owner" = "auth"."uid"())) WITH CHECK (("owner" = "auth"."uid"()));



CREATE POLICY "agm_room_read" ON "public"."agent_group_messages" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."agent_groups" "g"
  WHERE (("g"."id" = "agent_group_messages"."group_id") AND ("g"."owner_user" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."agent_group_viewers" "v"
  WHERE (("v"."group_id" = "agent_group_messages"."group_id") AND ("v"."user_id" = "auth"."uid"()))))));



ALTER TABLE "public"."blocks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "blocks_delete" ON "public"."blocks" FOR DELETE USING (("blocker" = "auth"."uid"()));



CREATE POLICY "blocks_insert" ON "public"."blocks" FOR INSERT WITH CHECK ((("blocker" = "auth"."uid"()) AND ("blocker" <> "blocked")));



CREATE POLICY "blocks_select" ON "public"."blocks" FOR SELECT USING (("blocker" = "auth"."uid"()));



ALTER TABLE "public"."context_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."friendships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "friendships_delete" ON "public"."friendships" FOR DELETE USING ((("auth"."uid"() = "requester") OR ("auth"."uid"() = "addressee")));



CREATE POLICY "friendships_insert" ON "public"."friendships" FOR INSERT WITH CHECK ((("requester" = "auth"."uid"()) AND ("requester" <> "addressee") AND (NOT "public"."block_between"("addressee"))));



CREATE POLICY "friendships_read" ON "public"."friendships" FOR SELECT USING ((("auth"."uid"() = "requester") OR ("auth"."uid"() = "addressee")));



CREATE POLICY "friendships_update" ON "public"."friendships" FOR UPDATE USING ((("auth"."uid"() = "requester") OR ("auth"."uid"() = "addressee"))) WITH CHECK ((("auth"."uid"() = "addressee") OR (("auth"."uid"() = "requester") AND ("status" <> 'accepted'::"text"))));



CREATE POLICY "gm_delete" ON "public"."group_members" FOR DELETE USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."groups" "g"
  WHERE (("g"."id" = "group_members"."group_id") AND ("g"."created_by" = "auth"."uid"()))))));



CREATE POLICY "gm_insert" ON "public"."group_members" FOR INSERT WITH CHECK ((((EXISTS ( SELECT 1
   FROM "public"."groups" "g"
  WHERE (("g"."id" = "group_members"."group_id") AND ("g"."created_by" = "auth"."uid"())))) OR "public"."is_group_member"("group_id", "auth"."uid"())) AND (("user_id" = "auth"."uid"()) OR ((EXISTS ( SELECT 1
   FROM "public"."friendships" "f"
  WHERE (("f"."status" = 'accepted'::"text") AND ((("f"."requester" = "auth"."uid"()) AND ("f"."addressee" = "group_members"."user_id")) OR (("f"."requester" = "group_members"."user_id") AND ("f"."addressee" = "auth"."uid"())))))) AND (NOT "public"."block_between"("user_id"))))));



CREATE POLICY "gm_select" ON "public"."group_members" FOR SELECT USING ("public"."is_group_member"("group_id", "auth"."uid"()));



ALTER TABLE "public"."group_epochs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "group_epochs_insert" ON "public"."group_epochs" FOR INSERT WITH CHECK ((("minted_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "group_epochs"."group_id") AND ("gm"."user_id" = "auth"."uid"()))))));



CREATE POLICY "group_epochs_read" ON "public"."group_epochs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "group_epochs"."group_id") AND ("gm"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."group_keys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "group_keys_insert" ON "public"."group_keys" FOR INSERT WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "group_keys"."group_id") AND ("gm"."user_id" = "auth"."uid"())))) AND (EXISTS ( SELECT 1
   FROM "public"."group_members" "gm2"
  WHERE (("gm2"."group_id" = "group_keys"."group_id") AND ("gm2"."user_id" = "group_keys"."user_id"))))));



CREATE POLICY "group_keys_read" ON "public"."group_keys" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."group_members" "gm"
  WHERE (("gm"."group_id" = "group_keys"."group_id") AND ("gm"."user_id" = "auth"."uid"())))));



ALTER TABLE "public"."group_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "groups_insert" ON "public"."groups" FOR INSERT WITH CHECK (("created_by" = "auth"."uid"()));



CREATE POLICY "groups_select" ON "public"."groups" FOR SELECT USING ("public"."is_group_member"("id", "auth"."uid"()));



ALTER TABLE "public"."message_reactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "messages_delete" ON "public"."messages" FOR DELETE USING ((("auth"."uid"() = "sender") OR ("auth"."uid"() = "recipient")));



CREATE POLICY "messages_insert" ON "public"."messages" FOR INSERT WITH CHECK ((("sender" = "auth"."uid"()) AND ((("group_id" IS NOT NULL) AND "public"."is_group_member"("group_id", "auth"."uid"())) OR (("group_id" IS NULL) AND ("recipient" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM "public"."friendships" "f"
  WHERE (("f"."status" = 'accepted'::"text") AND ((("f"."requester" = "auth"."uid"()) AND ("f"."addressee" = "messages"."recipient")) OR (("f"."requester" = "messages"."recipient") AND ("f"."addressee" = "auth"."uid"())))))) AND (NOT "public"."block_between"("recipient"))))));



CREATE POLICY "messages_read" ON "public"."messages" FOR SELECT USING ((("auth"."uid"() = "sender") OR ("auth"."uid"() = "recipient") OR (("group_id" IS NOT NULL) AND "public"."is_group_member"("group_id", "auth"."uid"()))));



CREATE POLICY "messages_update" ON "public"."messages" FOR UPDATE TO "authenticated" USING ((("auth"."uid"() = "sender") OR ("auth"."uid"() = "recipient"))) WITH CHECK ((("auth"."uid"() = "sender") OR ("auth"."uid"() = "recipient")));



CREATE POLICY "owner can delete own groups" ON "public"."agent_groups" FOR DELETE USING (("owner_user" = "auth"."uid"()));



CREATE POLICY "owner can read own groups" ON "public"."agent_groups" FOR SELECT USING (("owner_user" = "auth"."uid"()));



CREATE POLICY "owner can update own groups" ON "public"."agent_groups" FOR UPDATE USING (("owner_user" = "auth"."uid"())) WITH CHECK (("owner_user" = "auth"."uid"()));



ALTER TABLE "public"."poll_votes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."polls" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "polls_insert" ON "public"."polls" FOR INSERT WITH CHECK ((("creator" = "auth"."uid"()) AND "public"."is_group_member"("group_id", "auth"."uid"())));



CREATE POLICY "polls_select" ON "public"."polls" FOR SELECT USING ("public"."is_group_member"("group_id", "auth"."uid"()));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_insert" ON "public"."profiles" FOR INSERT WITH CHECK (("id" = "auth"."uid"()));



CREATE POLICY "profiles_read" ON "public"."profiles" FOR SELECT USING (true);



CREATE POLICY "profiles_update" ON "public"."profiles" FOR UPDATE USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));



CREATE POLICY "push_sub_delete" ON "public"."push_subscriptions" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "push_sub_insert" ON "public"."push_subscriptions" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "push_sub_select" ON "public"."push_subscriptions" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "push_sub_update" ON "public"."push_subscriptions" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."push_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pv_delete" ON "public"."poll_votes" FOR DELETE USING (("voter" = "auth"."uid"()));



CREATE POLICY "pv_insert" ON "public"."poll_votes" FOR INSERT WITH CHECK ((("voter" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."polls" "p"
  WHERE (("p"."id" = "poll_votes"."poll_id") AND "public"."is_group_member"("p"."group_id", "auth"."uid"()))))));



CREATE POLICY "pv_select" ON "public"."poll_votes" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."polls" "p"
  WHERE (("p"."id" = "poll_votes"."poll_id") AND "public"."is_group_member"("p"."group_id", "auth"."uid"())))));



CREATE POLICY "pv_update" ON "public"."poll_votes" FOR UPDATE USING (("voter" = "auth"."uid"())) WITH CHECK (("voter" = "auth"."uid"()));



ALTER TABLE "public"."rate_limits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reactions_delete" ON "public"."message_reactions" FOR DELETE USING (("user_id" = "auth"."uid"()));



CREATE POLICY "reactions_insert" ON "public"."message_reactions" FOR INSERT WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."messages" "m"
  WHERE (("m"."id" = "message_reactions"."message_id") AND ((("auth"."uid"() = "m"."sender") OR ("auth"."uid"() = "m"."recipient")) OR (("m"."group_id" IS NOT NULL) AND "public"."is_group_member"("m"."group_id", "auth"."uid"()))))))));



CREATE POLICY "reactions_select" ON "public"."message_reactions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."messages" "m"
  WHERE (("m"."id" = "message_reactions"."message_id") AND ((("auth"."uid"() = "m"."sender") OR ("auth"."uid"() = "m"."recipient")) OR (("m"."group_id" IS NOT NULL) AND "public"."is_group_member"("m"."group_id", "auth"."uid"())))))));



CREATE POLICY "reactions_update" ON "public"."message_reactions" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reports_insert" ON "public"."reports" FOR INSERT WITH CHECK ((("reporter" = "auth"."uid"()) AND ("reporter" <> "reported")));



CREATE POLICY "sched_delete" ON "public"."scheduled_messages" FOR DELETE USING (("sender" = "auth"."uid"()));



CREATE POLICY "sched_insert" ON "public"."scheduled_messages" FOR INSERT WITH CHECK ((("sender" = "auth"."uid"()) AND ("recipient" <> "sender") AND (EXISTS ( SELECT 1
   FROM "public"."friendships" "f"
  WHERE (("f"."status" = 'accepted'::"text") AND ((("f"."requester" = "auth"."uid"()) AND ("f"."addressee" = "scheduled_messages"."recipient")) OR (("f"."requester" = "scheduled_messages"."recipient") AND ("f"."addressee" = "auth"."uid"())))))) AND (NOT "public"."block_between"("recipient"))));



CREATE POLICY "sched_select" ON "public"."scheduled_messages" FOR SELECT USING (("sender" = "auth"."uid"()));



ALTER TABLE "public"."scheduled_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."signup_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."thread_reads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "thread_reads_insert" ON "public"."thread_reads" FOR INSERT WITH CHECK (("owner" = "auth"."uid"()));



CREATE POLICY "thread_reads_select" ON "public"."thread_reads" FOR SELECT USING (("owner" = "auth"."uid"()));



CREATE POLICY "thread_reads_select_other" ON "public"."thread_reads" FOR SELECT TO "authenticated" USING (("other" = "auth"."uid"()));



CREATE POLICY "thread_reads_update" ON "public"."thread_reads" FOR UPDATE USING (("owner" = "auth"."uid"())) WITH CHECK (("owner" = "auth"."uid"()));



ALTER TABLE "public"."thread_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "thread_settings_insert" ON "public"."thread_settings" FOR INSERT WITH CHECK ((("auth"."uid"() = "user_a") OR ("auth"."uid"() = "user_b")));



CREATE POLICY "thread_settings_select" ON "public"."thread_settings" FOR SELECT USING ((("auth"."uid"() = "user_a") OR ("auth"."uid"() = "user_b")));



CREATE POLICY "thread_settings_update" ON "public"."thread_settings" FOR UPDATE USING ((("auth"."uid"() = "user_a") OR ("auth"."uid"() = "user_b"))) WITH CHECK ((("auth"."uid"() = "user_a") OR ("auth"."uid"() = "user_b")));



ALTER TABLE "public"."user_keys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_keys_insert" ON "public"."user_keys" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));



CREATE POLICY "user_keys_select" ON "public"."user_keys" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "user_keys_update" ON "public"."user_keys" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."agent_group_messages";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."messages";






GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextin"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextout"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextrecv"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citextsend"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"(boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext"(character) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "anon";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"(character) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext"("inet") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "anon";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext"("inet") TO "service_role";











































































































































































GRANT ALL ON FUNCTION "public"."block_between"("other" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."block_between"("other" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."block_between"("other" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_cmp"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_eq"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_ge"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_gt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_hash"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_hash_extended"("public"."citext", bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_larger"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_le"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_lt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_ne"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_cmp"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_ge"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_gt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_le"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_pattern_lt"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."citext_smaller"("public"."citext", "public"."citext") TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_agent_room"("p_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_agent_room"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_agent_room"("p_code" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_group"("name" "text", "members" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_group"("name" "text", "members" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_group"("name" "text", "members" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_agent_room"("p_group" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_agent_room"("p_group" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_agent_room"("p_group" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."deliver_scheduled"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deliver_scheduled"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_block"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_block"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_friend_block"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_friend_block"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_friend_rate"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_friend_rate"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."enforce_message_rate"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_message_rate"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_group_member"("g" "uuid", "u" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_group_member"("g" "uuid", "u" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_group_member"("g" "uuid", "u" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."join_ping_hq"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."join_ping_hq"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_ping_hq"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."kick_agent_member"("p_group" "uuid", "p_member" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."kick_agent_member"("p_group" "uuid", "p_member" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."kick_agent_member"("p_group" "uuid", "p_member" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."list_agent_members"("p_group" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."list_agent_members"("p_group" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."list_agent_members"("p_group" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."notify_new_message"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notify_new_message"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prune_expired_messages"() TO "anon";
GRANT ALL ON FUNCTION "public"."prune_expired_messages"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prune_expired_messages"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."push_secrets"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."push_secrets"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."reap_rate_limits"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reap_rate_limits"() TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_match"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_matches"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_replace"("public"."citext", "public"."citext", "text", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_array"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."regexp_split_to_table"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."replace"("public"."citext", "public"."citext", "public"."citext") TO "service_role";



REVOKE ALL ON FUNCTION "public"."rl_hit"("p_bucket" "text", "p_limit" integer, "p_window_secs" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rl_hit"("p_bucket" "text", "p_limit" integer, "p_window_secs" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."rl_hook"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."rl_hook"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rl_hook"("p_token" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."split_part"("public"."citext", "public"."citext", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."strpos"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticlike"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticnlike"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexeq"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."texticregexne"("public"."citext", "public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "postgres";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "anon";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."translate"("public"."citext", "public"."citext", "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."unread_counts"() TO "anon";
GRANT ALL ON FUNCTION "public"."unread_counts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."unread_counts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."watch_agent_room"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."watch_agent_room"("p_code" "text") TO "service_role";












GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."max"("public"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "postgres";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."min"("public"."citext") TO "service_role";















GRANT ALL ON TABLE "public"."agent_group_members" TO "anon";
GRANT ALL ON TABLE "public"."agent_group_members" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_group_members" TO "service_role";



GRANT ALL ON TABLE "public"."agent_group_messages" TO "anon";
GRANT ALL ON TABLE "public"."agent_group_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_group_messages" TO "service_role";



GRANT ALL ON TABLE "public"."agent_group_viewers" TO "anon";
GRANT ALL ON TABLE "public"."agent_group_viewers" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_group_viewers" TO "service_role";



GRANT ALL ON TABLE "public"."agent_groups" TO "anon";
GRANT ALL ON TABLE "public"."agent_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_groups" TO "service_role";



GRANT ALL ON TABLE "public"."agent_links" TO "anon";
GRANT ALL ON TABLE "public"."agent_links" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_links" TO "service_role";



GRANT ALL ON TABLE "public"."agent_messages" TO "anon";
GRANT ALL ON TABLE "public"."agent_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_messages" TO "service_role";



GRANT ALL ON TABLE "public"."agent_project_members" TO "anon";
GRANT ALL ON TABLE "public"."agent_project_members" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_project_members" TO "service_role";



GRANT ALL ON TABLE "public"."agent_projects" TO "anon";
GRANT ALL ON TABLE "public"."agent_projects" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_projects" TO "service_role";



GRANT ALL ON TABLE "public"."agents" TO "anon";
GRANT ALL ON TABLE "public"."agents" TO "authenticated";
GRANT ALL ON TABLE "public"."agents" TO "service_role";



GRANT ALL ON TABLE "public"."blocks" TO "anon";
GRANT ALL ON TABLE "public"."blocks" TO "authenticated";
GRANT ALL ON TABLE "public"."blocks" TO "service_role";



GRANT ALL ON TABLE "public"."context_entries" TO "anon";
GRANT ALL ON TABLE "public"."context_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."context_entries" TO "service_role";



GRANT ALL ON TABLE "public"."friendships" TO "anon";
GRANT ALL ON TABLE "public"."friendships" TO "authenticated";
GRANT ALL ON TABLE "public"."friendships" TO "service_role";



GRANT ALL ON TABLE "public"."group_epochs" TO "anon";
GRANT ALL ON TABLE "public"."group_epochs" TO "authenticated";
GRANT ALL ON TABLE "public"."group_epochs" TO "service_role";



GRANT ALL ON TABLE "public"."group_keys" TO "anon";
GRANT ALL ON TABLE "public"."group_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."group_keys" TO "service_role";



GRANT ALL ON TABLE "public"."group_members" TO "anon";
GRANT ALL ON TABLE "public"."group_members" TO "authenticated";
GRANT ALL ON TABLE "public"."group_members" TO "service_role";



GRANT ALL ON TABLE "public"."groups" TO "anon";
GRANT ALL ON TABLE "public"."groups" TO "authenticated";
GRANT ALL ON TABLE "public"."groups" TO "service_role";



GRANT ALL ON TABLE "public"."message_reactions" TO "anon";
GRANT ALL ON TABLE "public"."message_reactions" TO "authenticated";
GRANT ALL ON TABLE "public"."message_reactions" TO "service_role";



GRANT ALL ON TABLE "public"."messages" TO "anon";
GRANT ALL ON TABLE "public"."messages" TO "authenticated";
GRANT ALL ON TABLE "public"."messages" TO "service_role";



GRANT ALL ON TABLE "public"."poll_votes" TO "anon";
GRANT ALL ON TABLE "public"."poll_votes" TO "authenticated";
GRANT ALL ON TABLE "public"."poll_votes" TO "service_role";



GRANT ALL ON TABLE "public"."polls" TO "anon";
GRANT ALL ON TABLE "public"."polls" TO "authenticated";
GRANT ALL ON TABLE "public"."polls" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."push_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."push_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."push_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."rate_limits" TO "anon";
GRANT ALL ON TABLE "public"."rate_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."rate_limits" TO "service_role";



GRANT ALL ON TABLE "public"."reports" TO "anon";
GRANT ALL ON TABLE "public"."reports" TO "authenticated";
GRANT ALL ON TABLE "public"."reports" TO "service_role";



GRANT ALL ON TABLE "public"."scheduled_messages" TO "anon";
GRANT ALL ON TABLE "public"."scheduled_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."scheduled_messages" TO "service_role";



GRANT ALL ON TABLE "public"."signup_attempts" TO "anon";
GRANT ALL ON TABLE "public"."signup_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."signup_attempts" TO "service_role";



GRANT ALL ON TABLE "public"."thread_reads" TO "anon";
GRANT ALL ON TABLE "public"."thread_reads" TO "authenticated";
GRANT ALL ON TABLE "public"."thread_reads" TO "service_role";



GRANT ALL ON TABLE "public"."thread_settings" TO "anon";
GRANT ALL ON TABLE "public"."thread_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."thread_settings" TO "service_role";



GRANT ALL ON TABLE "public"."user_keys" TO "anon";
GRANT ALL ON TABLE "public"."user_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."user_keys" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































