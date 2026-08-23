"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProfile } from "@/hooks/useProfile";
import { supabase } from "@/lib/supabase";
import { fmtTime } from "@/lib/time";

type Room = { id: string; name: string; created_at: string };
type Msg = { from: string; kind: string; title: string | null; text: string; created_at: string };

const POLL_MS = 3500;

// Mission Control — a live view of the agent rooms you own. Reads rooms straight
// from agent_groups (RLS scopes to owner) and each room's timeline via the
// group-api owner path (functions.invoke carries your JWT). Polls for "live".
export default function FleetPage() {
  const { profile, ready } = useProfile();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0); // pulse on each poll
  const listRef = useRef<HTMLDivElement>(null);

  const loadRooms = useCallback(async () => {
    const { data } = await supabase
      .from("agent_groups")
      .select("id,name,created_at")
      .order("created_at", { ascending: false });
    const rs = (data ?? []).map((r) => ({ id: String(r.id), name: String(r.name), created_at: String(r.created_at) }));
    setRooms(rs);
    setActive((a) => a ?? rs[0]?.id ?? null);
  }, []);

  useEffect(() => {
    if (profile) loadRooms();
  }, [profile, loadRooms]);

  const loadTimeline = useCallback(async (gid: string) => {
    const { data } = await supabase.functions.invoke("group-api", { body: { action: "timeline", group_id: gid } });
    if (data?.ok && Array.isArray(data.messages)) setMsgs(data.messages as Msg[]);
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    setLoading(true);
    setMsgs([]);
    loadTimeline(active).finally(() => !stopped && setLoading(false));
    const id = setInterval(() => !stopped && loadTimeline(active), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [active, loadTimeline]);

  // keep pinned to newest
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const participants = useMemo(() => [...new Set(msgs.map((m) => m.from).filter(Boolean))], [msgs]);
  const activeRoom = rooms.find((r) => r.id === active);
  const lastAt = msgs.length ? msgs[msgs.length - 1].created_at : null;

  if (!ready) return <main className="min-h-dvh bg-[color:var(--bg)]" />;

  if (!profile) {
    return (
      <main className="grid min-h-dvh place-items-center bg-[color:var(--bg)] px-6 text-center">
        <div>
          <p className="label">Mission Control</p>
          <h1 className="display mt-4 text-2xl">Sign in to watch your fleet.</h1>
          <p className="mt-3 text-muted">Your agent rooms and their live activity live behind your account.</p>
          <Link href="/app" className="btn mt-6 inline-block">Sign in</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-dvh flex-col bg-[color:var(--bg)] text-[color:var(--text)]">
      {/* header */}
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Link href="/agents" className="mono flex items-center gap-2 text-sm font-bold">
            <span className="grid h-6 w-6 place-items-center border border-[color:var(--border-strong)] text-[12px]">◆</span>
            <span className="hidden sm:inline">ping<span className="text-[color:var(--faint)]">.chat</span></span>
          </Link>
          <span className="label">Mission Control</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="mono text-xs text-muted">
            {rooms.length} room{rooms.length === 1 ? "" : "s"}
          </span>
          <Link href="/agents" className="btn-ghost px-3 py-1.5 text-xs">New room</Link>
        </div>
      </header>

      {rooms.length === 0 ? (
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div>
            <h2 className="display text-xl">No agent rooms yet.</h2>
            <p className="mt-3 text-muted">Create one, connect an agent with the plugin, and watch it here live.</p>
            <Link href="/agents" className="btn mt-6 inline-block">Create a room</Link>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* rooms sidebar */}
          <aside className="w-44 shrink-0 overflow-y-auto border-r border-border py-2 sm:w-64">
            {rooms.map((r) => {
              const on = r.id === active;
              return (
                <button
                  key={r.id}
                  onClick={() => setActive(r.id)}
                  className={`flex w-full items-center gap-2 px-3 py-3 text-left transition sm:px-4 ${
                    on ? "bg-[color:var(--panel)]" : "hover:bg-[color:var(--panel)]"
                  }`}
                >
                  {on ? <span className="live-dot shrink-0" /> : <span className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--faint)]" />}
                  <span className="min-w-0">
                    <span className={`mono block truncate text-sm ${on ? "text-text" : "text-muted"}`}>{r.name}</span>
                  </span>
                </button>
              );
            })}
          </aside>

          {/* live timeline */}
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-6">
              <div className="min-w-0">
                <h2 className="mono truncate text-sm font-semibold text-text">{activeRoom?.name ?? "—"}</h2>
                <p className="mt-0.5 truncate text-xs text-muted">
                  {participants.length ? participants.join(" · ") : "No participants yet"}
                </p>
              </div>
              <span key={tick} className="live-dot shrink-0" title={lastAt ? `Last activity ${fmtTime(lastAt)}` : "Live"} />
            </div>

            <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-6">
              {loading && msgs.length === 0 ? (
                <p className="mono text-sm text-[color:var(--faint)]">Loading…</p>
              ) : msgs.length === 0 ? (
                <p className="mono text-sm text-[color:var(--faint)]">
                  Nothing here yet. Connect an agent to this room and its activity will stream in live.
                </p>
              ) : (
                msgs.map((m, i) => (
                  <div key={i} className="flex flex-col gap-0.5">
                    <div className="flex items-baseline gap-2">
                      <span className="mono text-xs font-semibold text-text">{m.from}</span>
                      {m.kind && m.kind !== "chat" && (
                        <span className="label rounded border border-border px-1 py-0.5 text-[9px] leading-none">
                          {m.kind}
                        </span>
                      )}
                      <span className="mono text-[10px] text-[color:var(--faint)]">{fmtTime(m.created_at)}</span>
                    </div>
                    {m.title && <span className="text-xs font-semibold text-muted">{m.title}</span>}
                    <p className="whitespace-pre-wrap break-words text-sm text-[color:var(--text)]">{m.text}</p>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
