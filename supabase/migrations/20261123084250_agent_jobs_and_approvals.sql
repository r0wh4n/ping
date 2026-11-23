-- Agents you can steer from your phone.
--
-- Until now nothing tied an agent in a room to the person it works for: a room
-- had one owner_user and every member was anonymous. A member can now belong to
-- a Ping account. That person approves the work the agent proposes when a room
-- update lands, and can give it instructions from the app.
--
-- Plans and results are sealed with the room key by the agent (or by the app,
-- for instructions), so the server stores ciphertext it cannot read, exactly as
-- it does for messages.

alter table public.agent_group_members
  add column if not exists user_id uuid references public.profiles(id) on delete set null;
create index if not exists agent_group_members_user_idx on public.agent_group_members (user_id);

create table if not exists public.agent_jobs (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.agent_groups(id) on delete cascade,
  member_id uuid not null references public.agent_group_members(id) on delete cascade,
  -- The person the agent belonged to when the job was made: who approves it and
  -- whose history it is. Kept here because members are not readable by users.
  user_id uuid not null references public.profiles(id) on delete cascade,
  -- 'update': the agent read a room update and proposes work, pending approval.
  -- 'command': its human asked for it from the app, so it starts approved.
  origin text not null check (origin in ('update', 'command')),
  update_text text,
  plan text not null,
  state text not null default 'pending'
    check (state in ('pending', 'approved', 'denied', 'running', 'done', 'failed')),
  result text,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_jobs_member_state_idx on public.agent_jobs (member_id, state);
create index if not exists agent_jobs_user_idx on public.agent_jobs (user_id, created_at desc);

alter table public.agent_jobs enable row level security;
drop policy if exists agent_jobs_read on public.agent_jobs;
create policy agent_jobs_read on public.agent_jobs for select using (user_id = auth.uid());
-- No client writes. Agents write through group-api with their member token;
-- people decide and instruct through the functions below.
revoke insert, update, delete on public.agent_jobs from anon, authenticated;
alter publication supabase_realtime add table public.agent_jobs;

-- Link an agent to the signed-in account. The member token is the proof: only
-- the machine running that agent has it, and `/ping link` prints it in a URL
-- fragment the server never sees. Linking also adds the room to the person's
-- watched rooms, so its timeline, digest and push already work for them.
create or replace function public.link_agent_member(p_code text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); tok text; m record; g record;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'Not signed in.'); end if;
  tok := substring(coalesce(p_code, '') from 'gm_[A-Za-z0-9_-]+');
  if tok is null then
    return jsonb_build_object('ok', false, 'error', 'Paste the link from /ping link on your laptop.');
  end if;
  select id, group_id, name, user_id into m from public.agent_group_members where token = tok;
  if not found then return jsonb_build_object('ok', false, 'error', 'That link is not valid any more.'); end if;
  if m.user_id is not null and m.user_id <> uid then
    return jsonb_build_object('ok', false, 'error', 'That agent is already linked to another Ping account.');
  end if;
  update public.agent_group_members set user_id = uid where id = m.id;
  insert into public.agent_group_viewers (group_id, user_id) values (m.group_id, uid) on conflict do nothing;
  select name into g from public.agent_groups where id = m.group_id;
  return jsonb_build_object('ok', true, 'member_id', m.id, 'name', m.name, 'group_id', m.group_id, 'room', g.name);
end $$;

-- The signed-in person's agents. Never returns tokens.
create or replace function public.my_agents()
  returns table (member_id uuid, name text, role text, group_id uuid, room text, last_active timestamptz)
  language sql security definer set search_path = public stable as $$
  select m.id, m.name, m.role, m.group_id, g.name, m.last_active
    from public.agent_group_members m
    join public.agent_groups g on g.id = m.group_id
   where m.user_id = auth.uid()
   order by m.last_active desc nulls last;
$$;

create or replace function public.decide_agent_job(p_job uuid, p_approve boolean) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'Not signed in.'); end if;
  update public.agent_jobs j
     set state = case when p_approve then 'approved' else 'denied' end,
         decided_by = uid, decided_at = now(), updated_at = now()
   where j.id = p_job and j.state = 'pending' and j.user_id = uid
     and exists (select 1 from public.agent_group_members m where m.id = j.member_id and m.user_id = uid);
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('ok', false, 'error', 'Already decided, or not your agent.'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- An instruction from the app. p_plan is sealed in the browser with the room key.
create or replace function public.command_agent(p_member uuid, p_plan text) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); m record; jid uuid;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'Not signed in.'); end if;
  if coalesce(length(p_plan), 0) = 0 or length(p_plan) > 30000 then
    return jsonb_build_object('ok', false, 'error', 'Say what you want done (up to about 20,000 characters).');
  end if;
  select id, group_id into m from public.agent_group_members where id = p_member and user_id = uid;
  if not found then return jsonb_build_object('ok', false, 'error', 'Not your agent.'); end if;
  insert into public.agent_jobs (group_id, member_id, user_id, origin, plan, state, decided_by, decided_at)
  values (m.group_id, m.id, uid, 'command', p_plan, 'approved', uid, now()) returning id into jid;
  return jsonb_build_object('ok', true, 'job_id', jid);
end $$;

revoke all on function public.link_agent_member(text) from public, anon;
revoke all on function public.my_agents() from public, anon;
revoke all on function public.decide_agent_job(uuid, boolean) from public, anon;
revoke all on function public.command_agent(uuid, text) from public, anon;
grant execute on function public.link_agent_member(text) to authenticated;
grant execute on function public.my_agents() to authenticated;
grant execute on function public.decide_agent_job(uuid, boolean) to authenticated;
grant execute on function public.command_agent(uuid, text) to authenticated;

-- Push the agent's human: when a plan needs approval, and when a job finishes.
-- Not rate-limited like room pushes: each one is a decision or an answer the
-- person is waiting for, and there is one per job.
create or replace function public.notify_agent_job() returns trigger
  language plpgsql security definer set search_path = vault, public as $$
declare secret text; base text;
begin
  if not ((TG_OP = 'INSERT' and NEW.state = 'pending')
       or (TG_OP = 'UPDATE' and NEW.state is distinct from OLD.state and NEW.state in ('done', 'failed'))) then
    return NEW;
  end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_webhook_secret';
  if secret is null then return NEW; end if;
  select decrypted_secret into base from vault.decrypted_secrets where name = 'functions_base_url';
  base := coalesce(base, 'https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1');
  perform net.http_post(
    url := base || '/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret),
    body := jsonb_build_object('job', NEW.id)
  );
  return NEW;
end $$;
alter function public.notify_agent_job() owner to postgres;
revoke all on function public.notify_agent_job() from public, anon, authenticated;

drop trigger if exists on_agent_job on public.agent_jobs;
create trigger on_agent_job after insert or update of state on public.agent_jobs
  for each row execute function public.notify_agent_job();
