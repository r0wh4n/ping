"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useProfile } from "@/hooks/useProfile";
import { supabase } from "@/lib/supabase";
import { getRoomKey, importRoomKey, isSealed, keyFromInput, openText, sealText, setRoomKey } from "@/lib/roomKeys";
import Avatar from "@/components/Avatar";
import AppTabs from "@/components/AppTabs";
import Markdown from "@/components/Markdown";

// Agents, on your phone. Each agent you link (from `/ping link` on the laptop it
// runs on) shows up here with its room's latest activity. When a teammate posts
// an update, the runner on that laptop proposes a plan and it waits here for
// your OK; you can also tell the agent what to do. Everything an agent writes is
// sealed with the room key, which this device holds only if the link was
// opened here.

type Agent = { member_id: string; name: string; role: string | null; group_id: string; room: string; last_active: string | null };
type Job = {
  id: string;
  member_id: string;
  group_id: string;
  origin: "update" | "command";
  state: "pending" | "approved" | "denied" | "running" | "done" | "failed";
  plan: string;
  update_text: string | null;
  result: string | null;
  created_at: string;
};
type Msg = { id: string; from: string; kind: string; text: string; created_at: string };

const STATE_LABEL: Record<Job["state"], string> = {
  pending: "Waiting for you",
  approved: "Approved · starting",
  denied: "Denied",
  running: "Working…",
  done: "Done",
  failed: "Couldn't finish",
};

function seen(iso: string | null): { live: boolean; text: string } {
  if (!iso) return { live: false, text: "not seen yet" };
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 120) return { live: true, text: "active now" };
  if (s < 3600) return { live: false, text: `seen ${Math.floor(s / 60)}m ago` };
  if (s < 86400) return { live: false, text: `seen ${Math.floor(s / 3600)}h ago` };
  return { live: false, text: `seen ${Math.floor(s / 86400)}d ago` };
}

const LOCKED = "🔒 This phone can't read it yet. Open the link from /ping link on this phone.";
const shown = (v: string | null) => (v && isSealed(v) ? LOCKED : (v ?? ""));

export default function AgentsPage() {
  const { profile, ready } = useProfile();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [msgs, setMsgs] = useState<Record<string, Msg[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [linkInput, setLinkInput] = useState("");
  const loading = useRef(false);

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const { data } = await supabase.rpc("my_agents");
      const list = (data ?? []) as Agent[];
      const gids = [...new Set(list.map((a) => a.group_id))];
      const keys: Record<string, CryptoKey | null> = {};
      for (const g of gids) keys[g] = await importRoomKey(getRoomKey(g));

      const { data: jr } = list.length
        ? await supabase
            .from("agent_jobs")
            .select("id,member_id,group_id,origin,state,plan,update_text,result,created_at")
            .order("created_at", { ascending: false })
            .limit(60)
        : { data: [] };
      const opened = await Promise.all(
        ((jr ?? []) as Job[]).map(async (j) => {
          const k = keys[j.group_id] ?? null;
          return {
            ...j,
            plan: await openText(j.plan, k),
            update_text: j.update_text ? await openText(j.update_text, k) : null,
            result: j.result ? await openText(j.result, k) : null,
          };
        })
      );

      const timeline: Record<string, Msg[]> = {};
      await Promise.all(
        gids.map(async (g) => {
          const { data: rows } = await supabase
            .from("agent_group_messages")
            .select("id,author_name,source,kind,title,body,created_at")
            .eq("group_id", g)
            .order("created_at", { ascending: false })
            .limit(12);
          timeline[g] = await Promise.all(
            (rows ?? []).reverse().map(async (r) => {
              const title = r.title ? await openText(String(r.title), keys[g]) : "";
              const body = await openText(String(r.body ?? ""), keys[g]);
              return {
                id: String(r.id),
                from: String(r.author_name ?? r.source ?? "?"),
                kind: String(r.kind ?? "chat"),
                text: title && !isSealed(title) ? `${title}: ${body}` : body,
                created_at: String(r.created_at),
              };
            })
          );
        })
      );

      setAgents(list);
      setJobs(opened);
      setMsgs(timeline);
    } finally {
      loading.current = false;
    }
  }, []);

  const linked = useCallback(
    (input: string, data: unknown, error: { message: string } | null) => {
      const r = data as { ok: boolean; error?: string; name?: string; room?: string; group_id?: string } | null;
      if (error || !r?.ok) return setNote({ ok: false, text: r?.error ?? error?.message ?? "Couldn't link that agent." });
      const k = keyFromInput(input);
      if (k && r.group_id) setRoomKey(r.group_id, k);
      setLinkInput("");
      setNote({ ok: true, text: `Linked ${r.name} in ${r.room}.` });
      load();
    },
    [load]
  );

  const link = async (input: string) => {
    const code = /gm_[A-Za-z0-9_-]+/.exec(input)?.[0];
    if (!code) return setNote({ ok: false, text: "Paste the link from /ping link on your laptop." });
    setBusy("link");
    const { data, error } = await supabase.rpc("link_agent_member", { p_code: code });
    setBusy(null);
    linked(input, data, error);
  };

  useEffect(() => {
    if (!profile) return;
    // Opened from `/ping link`: the token and key are in the fragment. Take the
    // token off the address bar first, so it is not left in history.
    const hash = window.location.hash;
    const code = /link=(gm_[A-Za-z0-9_-]+)/.exec(hash)?.[1];
    if (code) {
      history.replaceState(null, "", window.location.pathname);
      void supabase.rpc("link_agent_member", { p_code: code }).then(({ data, error }) => linked(hash, data, error));
    } else void load();
  }, [profile, linked, load]);

  // Live: a plan arriving, a job finishing, a room moving. Each just reloads;
  // the lists are short.
  const roomIds = agents ? [...new Set(agents.map((a) => a.group_id))].join(",") : "";
  useEffect(() => {
    if (!profile || !roomIds) return;
    const ch = supabase
      .channel(`agents:${profile.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_jobs" }, () => void load())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_group_messages", filter: `group_id=in.(${roomIds})` }, () => void load())
      .subscribe();
    const onShow = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      supabase.removeChannel(ch);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [profile, roomIds, load]);

  const decide = async (job: Job, approve: boolean) => {
    setBusy(job.id);
    const { data, error } = await supabase.rpc("decide_agent_job", { p_job: job.id, p_approve: approve });
    setBusy(null);
    const r = data as { ok: boolean; error?: string } | null;
    if (error || !r?.ok) setNote({ ok: false, text: r?.error ?? error?.message ?? "Couldn't record that." });
    load();
  };

  const command = async (a: Agent) => {
    const text = (drafts[a.member_id] ?? "").trim();
    if (!text) return;
    const sealed = await sealText(text, getRoomKey(a.group_id));
    if (!sealed) return setNote({ ok: false, text: `This phone doesn't hold ${a.room}'s key, so the instruction can't be encrypted. Open the link from /ping link on this phone.` });
    setBusy(a.member_id);
    const { data, error } = await supabase.rpc("command_agent", { p_member: a.member_id, p_plan: sealed });
    setBusy(null);
    const r = data as { ok: boolean; error?: string } | null;
    if (error || !r?.ok) return setNote({ ok: false, text: r?.error ?? error?.message ?? "Couldn't send that." });
    setDrafts((d) => ({ ...d, [a.member_id]: "" }));
    setNote({ ok: true, text: `Sent to ${a.name}. It starts as soon as the runner on that laptop picks it up.` });
    load();
  };

  if (!ready) return <main className="min-h-dvh" />;
  if (!profile)
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-muted">Sign in to see your agents.</p>
        <Link href="/app" className="btn">
          Sign in
        </Link>
      </main>
    );

  const byId = new Map((agents ?? []).map((a) => [a.member_id, a]));
  const pending = jobs.filter((j) => j.state === "pending" && byId.has(j.member_id));

  return (
    <main className="mx-auto min-h-dvh w-full max-w-2xl pb-safe">
      <nav className="flex items-center justify-between border-b border-border px-5 py-4">
        <Link href="/" className="mono text-[15px] font-semibold">
          ping<span className="text-[color:var(--faint)]">.chat</span>
        </Link>
        <span className="mono text-sm text-muted">@{profile.username}</span>
      </nav>
      <AppTabs active="agents" />

      <div className="flex flex-col gap-5 px-5 py-7">
        {note && (
          <p className={`text-sm ${note.ok ? "text-muted" : "text-[color:var(--danger)]"}`} role="status">
            {note.text}
          </p>
        )}

        {pending.length > 0 && (
          <section className="flex flex-col gap-3">
            <p className="label">WAITING FOR YOU · {pending.length}</p>
            {pending.map((j) => {
              const a = byId.get(j.member_id)!;
              return (
                <div key={j.id} className="card flex flex-col gap-3 p-5">
                  <div className="flex items-center gap-3">
                    <Avatar name={a.name} size={36} />
                    <p className="min-w-0 text-[15px] leading-snug">
                      <span className="font-semibold">{a.name}</span> has a plan
                      <span className="block truncate text-xs text-muted">{a.room}</span>
                    </p>
                  </div>
                  {j.update_text && (
                    <div className="bubble-in px-3.5 py-2 text-sm text-muted">
                      <span className="label mb-1 block text-[10px]">THE UPDATE</span>
                      <span className="whitespace-pre-wrap break-words">{shown(j.update_text)}</span>
                    </div>
                  )}
                  <div className="break-words text-[15px] leading-relaxed">
                    <Markdown text={shown(j.plan)} />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => decide(j, true)} disabled={busy === j.id} className="btn flex-1 justify-center py-2.5 text-sm disabled:opacity-40">
                      Approve
                    </button>
                    <button onClick={() => decide(j, false)} disabled={busy === j.id} className="btn-ghost flex-1 justify-center py-2.5 text-sm disabled:opacity-40">
                      Deny
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {agents?.map((a) => {
          const s = seen(a.last_active);
          const mine = jobs.filter((j) => j.member_id === a.member_id && j.state !== "pending").slice(0, 5);
          const room = msgs[a.group_id] ?? [];
          return (
            <section key={a.member_id} className="card flex flex-col gap-4 p-5">
              <div className="flex items-center gap-3">
                <Avatar name={a.name} live={s.live} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold">{a.name}</p>
                  <p className="truncate text-xs text-muted">
                    {a.room} · {s.text}
                  </p>
                </div>
              </div>

              <div className="flex items-end gap-2">
                <textarea
                  value={drafts[a.member_id] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [a.member_id]: e.target.value }))}
                  placeholder={`Tell ${a.name} what to do…`}
                  rows={2}
                  maxLength={20000}
                  className="min-w-0 flex-1 resize-none rounded-2xl border border-border bg-transparent px-4 py-2.5 text-[15px] leading-6 outline-none placeholder:text-[color:var(--faint)] focus:border-[color:var(--focus)]"
                />
                <button
                  onClick={() => command(a)}
                  disabled={busy === a.member_id || !(drafts[a.member_id] ?? "").trim()}
                  className="btn shrink-0 px-4 py-2.5 text-sm disabled:opacity-40"
                >
                  Send
                </button>
              </div>
              {!s.live && (
                <p className="text-xs text-[color:var(--faint)]">
                  To act on updates and instructions, keep the runner open on that laptop: run <span className="mono text-muted">/ping runner</span> in Claude Code there.
                </p>
              )}

              {mine.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="label">WORK</p>
                  {mine.map((j) => (
                    <details key={j.id} className="rounded-xl border border-border px-3.5 py-2.5">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate">{shown(j.plan).replace(/[*`#_>]/g, "").trim().split("\n")[0]}</span>
                        <span className={`shrink-0 text-xs ${j.state === "failed" ? "text-[color:var(--danger)]" : "text-muted"}`}>{STATE_LABEL[j.state]}</span>
                      </summary>
                      <div className="mt-2 flex flex-col gap-2 text-sm">
                        <div className="break-words text-muted">
                          <Markdown text={shown(j.plan)} />
                        </div>
                        {j.result && (
                          <div className="break-words border-t border-border pt-2">
                            <Markdown text={shown(j.result)} />
                          </div>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              )}

              {room.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <p className="label">ROOM</p>
                    <Link href="/fleet" className="text-xs text-muted transition hover:text-text">
                      Full history →
                    </Link>
                  </div>
                  {room.map((m) => (
                    <div key={m.id} className="text-sm leading-snug">
                      <span className="font-medium">{m.from}</span>
                      {m.kind !== "chat" && <span className="ml-1.5 text-[11px] uppercase tracking-wider text-[color:var(--faint)]">{m.kind}</span>}
                      <p className="line-clamp-3 whitespace-pre-wrap break-words text-muted">{shown(m.text)}</p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}

        <section className="card flex flex-col gap-3 p-5">
          <p className="label">{agents?.length ? "LINK ANOTHER AGENT" : "LINK YOUR LAPTOP AGENT"}</p>
          {!agents?.length && (
            <p className="text-sm leading-relaxed text-muted">
              Approve your agent&apos;s work and tell it what to do, from here. In Claude Code on your laptop, run{" "}
              <span className="mono text-text">/ping link</span>, then open the link on this phone or paste it below.
            </p>
          )}
          <div className="flex items-center gap-2">
            <input
              value={linkInput}
              onChange={(e) => setLinkInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && link(linkInput)}
              placeholder="https://theping.chat/app/agents#link=…"
              autoCapitalize="none"
              autoCorrect="off"
              className="mono min-w-0 flex-1 rounded-xl border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 py-2.5 text-sm outline-none placeholder:text-[color:var(--faint)] focus:border-[color:var(--focus)]"
            />
            <button onClick={() => link(linkInput)} disabled={busy === "link" || !linkInput.trim()} className="btn shrink-0 disabled:opacity-40">
              {busy === "link" ? "…" : "Link"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
