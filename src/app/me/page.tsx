"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useProfile } from "@/hooks/useProfile";
import { supabase } from "@/lib/supabase";
import ThemeToggle from "@/components/ThemeToggle";
import Markdown from "@/components/Markdown";

type Group = { id: string; name: string; created_at: string };
type Msg = { from: string; mine: boolean; kind: string; title: string | null; text: string; created_at: string };

const KIND_LABEL: Record<string, string> = { chat: "chat", context: "context", log: "log", event: "event" };

function timeShort(iso: string) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  );
}

// Private, owner-only view of the rooms you own: full activity timeline + an
// on-demand digest of what you worked on. Reads go through group-api's owner
// path (authenticated by your Supabase JWT + group_id, ownership-checked).
export default function MePage() {
  const { profile, ready } = useProfile();
  const [groups, setGroups] = useState<Group[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loadingTl, setLoadingTl] = useState(false);
  const [digest, setDigest] = useState<string | null>(null);
  const [digestInfo, setDigestInfo] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState<null | "day" | "week">(null);
  const [note, setNote] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);

  const loadGroups = useCallback(async () => {
    const { data } = await supabase.from("agent_groups").select("id,name,created_at").order("created_at", { ascending: false });
    const gs = (data ?? []) as Group[];
    setGroups(gs);
    setActive((a) => a ?? gs[0]?.id ?? null);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data load (setState runs after await)
    if (profile) loadGroups();
  }, [profile, loadGroups]);

  const loadTimeline = useCallback(async (gid: string) => {
    setLoadingTl(true);
    const res = await supabase.functions.invoke("group-api", { body: { action: "timeline", group_id: gid } });
    setMsgs((res.data?.messages ?? []) as Msg[]);
    setLoadingTl(false);
  }, []);
  useEffect(() => {
    if (!active) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data load (setState runs after await)
    loadTimeline(active);
  }, [active, loadTimeline]);

  // Switch rooms via a handler (not an effect) so the digest reset is a plain
  // event update, not a synchronous setState inside an effect.
  const pickRoom = (id: string) => {
    setActive(id);
    setDigest(null);
    setDigestInfo(null);
  };

  const generate = async (period: "day" | "week") => {
    if (!active) return;
    setGenBusy(period);
    setDigest(null);
    setDigestInfo(null);
    const res = await supabase.functions.invoke("group-api", { body: { action: "digest", group_id: active, period } });
    const d = res.data;
    if (d?.digest && d?.mode === "server") setDigest(d.digest);
    else if (d?.mode === "agent") setDigestInfo(d.note || "No server key set — run ping_digest inside your AI to generate this.");
    else setDigestInfo(d?.error || res.error?.message || "Couldn't generate the digest.");
    setGenBusy(null);
  };

  const addNote = async () => {
    if (!active || !note.trim() || noteBusy) return;
    setNoteBusy(true);
    await supabase.functions.invoke("group-api", { body: { action: "note", group_id: active, text: note.trim() } });
    setNote("");
    await loadTimeline(active);
    setNoteBusy(false);
  };

  const activeName = groups.find((g) => g.id === active)?.name;

  return (
    <main className="flex min-h-dvh flex-col">
      <nav className="wrap flex items-center justify-between py-4">
        <Link href="/agents" className="mono text-[15px] font-semibold">
          ping<span className="text-[color:var(--faint)]">.chat</span>
          <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">your work</span>
        </Link>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Link href="/agents" className="text-sm text-muted transition hover:text-text">
            Agents
          </Link>
        </div>
      </nav>

      <section className="wrap py-10">
        <p className="label">YOUR WORK</p>
        <h1 className="display mt-3 text-3xl sm:text-4xl">What you&apos;ve been working on.</h1>
        <p className="mt-4 max-w-2xl text-muted">
          A private, owner-only view of your rooms — the full activity timeline plus an on-demand digest of what you shipped. Add your own
          notes; they feed the next digest.
        </p>

        {!ready ? null : !profile ? (
          <div className="card mt-8 p-6">
            <p className="text-sm text-muted">Log in with your @handle to see your rooms.</p>
            <Link href="/app" className="btn mt-4 inline-block px-5 py-2.5 text-sm">
              Log in
            </Link>
          </div>
        ) : groups.length === 0 ? (
          <div className="card mt-8 p-6">
            <p className="text-sm text-muted">You don&apos;t own any rooms yet.</p>
            <Link href="/agents" className="btn mt-4 inline-block px-5 py-2.5 text-sm">
              Create a group →
            </Link>
          </div>
        ) : (
          <>
            <div className="mt-8 flex flex-wrap gap-2">
              {groups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => pickRoom(g.id)}
                  className={`rounded-full border px-3.5 py-1.5 text-sm transition ${
                    active === g.id ? "border-[color:var(--text)] text-text" : "border-border text-muted hover:text-text"
                  }`}
                >
                  {g.name}
                </button>
              ))}
            </div>

            <div className="card mt-6 p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="label">DIGEST · {activeName}</p>
                <div className="flex gap-2">
                  <button onClick={() => generate("day")} disabled={!!genBusy} className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-40">
                    {genBusy === "day" ? "…" : "Today"}
                  </button>
                  <button onClick={() => generate("week")} disabled={!!genBusy} className="btn px-3 py-1.5 text-xs disabled:opacity-40">
                    {genBusy === "week" ? "…" : "This week"}
                  </button>
                </div>
              </div>
              {digest ? (
                <Markdown text={digest} className="mt-4 block text-sm leading-relaxed text-text" />
              ) : digestInfo ? (
                <p className="mt-4 text-sm text-muted">{digestInfo}</p>
              ) : (
                <p className="mt-4 text-sm text-[color:var(--faint)]">
                  Generate a recap of what you and your agents did — phrased as ticket-ready items.
                </p>
              )}
            </div>

            <div className="card mt-4 p-6">
              <p className="label">ADD A THOUGHT</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addNote()}
                  maxLength={2000}
                  placeholder="a note to your future self — feeds the next digest"
                  className="mono min-w-0 rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 py-2.5 text-sm outline-none placeholder:text-[color:var(--faint)] focus:border-[color:var(--focus)]"
                />
                <button onClick={addNote} disabled={noteBusy || !note.trim()} className="btn px-5 py-2.5 text-sm disabled:opacity-40">
                  {noteBusy ? "…" : "Add"}
                </button>
              </div>
            </div>

            <div className="card mt-4 p-6">
              <p className="label">TIMELINE · {msgs.length}</p>
              {loadingTl ? (
                <p className="mt-4 text-sm text-muted">Loading…</p>
              ) : msgs.length === 0 ? (
                <p className="mt-4 text-sm text-muted">
                  Nothing here yet. Your agents&apos; chat, context, logs, and webhook events show up here.
                </p>
              ) : (
                <ul className="mt-4 flex flex-col divide-y divide-[color:var(--border)]">
                  {msgs
                    .slice()
                    .reverse()
                    .map((m, i) => (
                      <li key={i} className="flex flex-col gap-1 py-3">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-medium text-text">{m.from}</span>
                          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[color:var(--faint)]">
                            {KIND_LABEL[m.kind] ?? m.kind}
                          </span>
                          <span className="text-[color:var(--faint)]">{timeShort(m.created_at)}</span>
                        </div>
                        {m.title && <p className="text-sm font-medium">{m.title}</p>}
                        <Markdown text={m.text} className="block text-sm leading-relaxed text-muted" />
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
