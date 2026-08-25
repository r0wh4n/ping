"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProfile } from "@/hooks/useProfile";
import { supabase } from "@/lib/supabase";
import { fmtTime } from "@/lib/time";

type Room = { id: string; name: string; members: number; msgs_24h: number; last_at: string | null; last_from: string | null };
type Msg = { id?: string; from: string; kind: string; title: string | null; text: string; created_at: string };
type Member = { id: string; name: string; last_read: string | null; joined_at: string };
const KINDS = ["all", "chat", "context", "log", "event"] as const;

const TIMELINE_MS = 12000; // backstop poll; realtime handles instant delivery
const ROOMS_MS = 15000;
const ACTIVE_WINDOW = 10 * 60 * 1000; // "active" = activity within 10 min

function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// A live agent_group_messages row (from realtime) → the same shape as the API.
function shapeRow(r: Record<string, unknown>): Msg {
  return {
    id: (r.id as string) ?? undefined,
    from: (r.author_name as string) ?? (r.source as string) ?? "?",
    kind: String(r.kind ?? "chat"),
    title: (r.title as string) ?? null,
    text: String(r.body ?? ""),
    created_at: String(r.created_at),
  };
}

// Mission Control — a live view of the agent rooms you own. rooms_overview gives
// the whole fleet's activity in one call (sidebar + stats); the selected room's
// timeline streams via the owner path. Both carry your JWT via functions.invoke.
export default function FleetPage() {
  const { profile, ready } = useProfile();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [noMore, setNoMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimVal, setClaimVal] = useState("");
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [kind, setKind] = useState<string>("all");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const prevHeight = useRef<number | null>(null);

  const loadRooms = useCallback(async () => {
    const { data } = await supabase.functions.invoke("group-api", { body: { action: "rooms_overview" } });
    const rs: Room[] = data?.ok && Array.isArray(data.rooms) ? data.rooms : [];
    rs.sort((a, b) => (b.last_at ? Date.parse(b.last_at) : 0) - (a.last_at ? Date.parse(a.last_at) : 0));
    setRooms(rs);
    setActive((a) => a ?? rs[0]?.id ?? null);
  }, []);

  useEffect(() => {
    if (!profile) return;
    let stopped = false;
    loadRooms();
    const id = setInterval(() => !stopped && loadRooms(), ROOMS_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [profile, loadRooms]);

  const loadTimeline = useCallback(async (gid: string) => {
    const { data } = await supabase.functions.invoke("group-api", { body: { action: "timeline", group_id: gid } });
    if (data?.ok && Array.isArray(data.messages)) {
      const fresh = data.messages as Msg[];
      setMsgs((cur) => {
        if (!fresh.length) return cur;
        const cutoff = fresh[0].created_at; // keep any older history we've paged in below the live window
        const older = cur.filter((m) => m.created_at < cutoff);
        return [...older, ...fresh];
      });
    }
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    setLoading(true);
    setMsgs([]);
    setNoMore(false);
    setKind("all");
    setConfirmDelete(false);
    nearBottom.current = true;
    loadTimeline(active).finally(() => !stopped && setLoading(false));
    const id = setInterval(() => !stopped && loadTimeline(active), TIMELINE_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [active, loadTimeline]);

  // Realtime: append live inserts for the active room (poll above is a backstop).
  useEffect(() => {
    if (!active) return;
    const ch = supabase
      .channel(`fleet:${active}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_group_messages", filter: `group_id=eq.${active}` },
        ({ new: row }) => {
          const m = shapeRow(row as Record<string, unknown>);
          setMsgs((cur) =>
            cur.some((x) => (m.id && x.id === m.id) || (x.created_at === m.created_at && x.from === m.from && x.text === m.text))
              ? cur
              : [...cur, m]
          );
          setTick((t) => t + 1);
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [active]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (prevHeight.current !== null) {
      el.scrollTop = el.scrollHeight - prevHeight.current; // keep viewport stable after prepending older
      prevHeight.current = null;
    } else if (nearBottom.current) {
      el.scrollTop = el.scrollHeight; // follow live only when already at the bottom
    }
  }, [msgs]);

  const loadOlder = async () => {
    const oldest = msgs[0]?.created_at;
    if (!active || loadingOlder || noMore || !oldest) return;
    setLoadingOlder(true);
    prevHeight.current = listRef.current?.scrollHeight ?? 0;
    const { data } = await supabase.functions.invoke("group-api", {
      body: { action: "history", group_id: active, before: oldest, limit: 100 },
    });
    if (data?.ok && Array.isArray(data.messages)) {
      const older = data.messages as Msg[];
      if (older.length) setMsgs((cur) => [...older, ...cur]);
      if (!data.has_more || older.length === 0) setNoMore(true);
    } else {
      prevHeight.current = null;
    }
    setLoadingOlder(false);
  };

  // Adopt an ownerless room (created via /ping or MCP) so it appears in the
  // fleet. Takes the room's CLAIM link, not its invite link: the invite is given
  // to everyone who joins, so it can't prove you created the room. Uses the
  // claim_agent_room RPC (carries your JWT).
  const claim = async () => {
    const code = claimVal.trim();
    if (!code || claimBusy) return;
    setClaimBusy(true);
    setClaimErr(null);
    const { data, error } = await supabase.rpc("claim_agent_room", { p_code: code });
    setClaimBusy(false);
    if (error || !(data as { ok?: boolean })?.ok) {
      setClaimErr((data as { error?: string })?.error ?? "Couldn't claim that room.");
      return;
    }
    setClaimVal("");
    setClaimErr(null);
    setClaimOpen(false);
    await loadRooms();
    setActive(String((data as { group_id: string }).group_id));
  };

  // /ping claim prints a theping.chat/fleet?claim=… link. Opening it should land
  // ready to go, so prefill the box and strip the token back out of the URL —
  // it's a credential and shouldn't sit in history or get shared by copy-paste.
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("claim");
    if (!token) return;
    setClaimVal(token);
    setClaimOpen(true);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  // Roster (no tokens) via RPC; presence = last_read recency. Refreshed on a timer.
  const loadMembers = useCallback(async (gid: string) => {
    const { data } = await supabase.rpc("list_agent_members", { p_group: gid });
    setMembers(Array.isArray(data) ? (data as Member[]) : []);
  }, []);

  useEffect(() => {
    if (!active) {
      setMembers([]);
      return;
    }
    loadMembers(active);
    const id = setInterval(() => loadMembers(active), ROOMS_MS);
    return () => clearInterval(id);
  }, [active, loadMembers]);

  const kick = async (memberId: string) => {
    if (!active) return;
    await supabase.rpc("kick_agent_member", { p_group: active, p_member: memberId });
    loadMembers(active);
  };

  const deleteRoom = async () => {
    if (!active || busy) return;
    setBusy(true);
    const { data } = await supabase.rpc("delete_agent_room", { p_group: active });
    setBusy(false);
    if ((data as { ok?: boolean })?.ok) {
      setConfirmDelete(false);
      setActive(null);
      await loadRooms();
    }
  };

  const participants = useMemo(() => [...new Set(msgs.map((m) => m.from).filter(Boolean))], [msgs]);
  const shownMsgs = kind === "all" ? msgs : msgs.filter((m) => (m.kind || "chat") === kind);
  const activeRoom = rooms.find((r) => r.id === active);
  const stats = useMemo(() => {
    const now = Date.now();
    return {
      rooms: rooms.length,
      active: rooms.filter((r) => r.last_at && now - Date.parse(r.last_at) < 60 * 60 * 1000).length,
      today: rooms.reduce((s, r) => s + (r.msgs_24h || 0), 0),
    };
  }, [rooms]);

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
      {/* header + stat strip */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Link href="/agents" className="mono flex items-center gap-2 text-sm font-bold">
            <span className="grid h-6 w-6 place-items-center border border-[color:var(--border-strong)] text-[12px]">◆</span>
            <span className="hidden sm:inline">ping<span className="text-[color:var(--faint)]">.chat</span></span>
          </Link>
          <span className="label">Mission Control</span>
        </div>
        <div className="flex items-center gap-5">
          <div className="mono flex items-center gap-4 text-xs text-muted">
            <span><span className="text-text">{stats.rooms}</span> rooms</span>
            <span><span className="text-text">{stats.active}</span> active/hr</span>
            <span><span className="text-text">{stats.today}</span> msgs/24h</span>
          </div>
          <button onClick={() => setClaimOpen((o) => !o)} className="btn-ghost px-3 py-1.5 text-xs">Claim room</button>
          <Link href="/agents" className="btn-ghost px-3 py-1.5 text-xs">New room</Link>
        </div>
      </header>

      {claimOpen && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-[color:var(--panel)] px-4 py-3 sm:px-6">
          <input
            value={claimVal}
            onChange={(e) => setClaimVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && claim()}
            placeholder="Paste a room's claim link — run /ping claim in the agent that created it"
            className="mono min-w-0 flex-1 rounded-lg border border-border bg-[color:var(--bg)] px-3 py-2 text-sm outline-none focus:border-[color:var(--focus)]"
          />
          <button onClick={claim} disabled={claimBusy || !claimVal.trim()} className="btn px-4 py-2 text-xs disabled:opacity-40">
            {claimBusy ? "Claiming…" : "Claim"}
          </button>
          {claimErr && <span className="text-xs text-[color:var(--danger)]">{claimErr}</span>}
        </div>
      )}

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
          <aside className="w-48 shrink-0 overflow-y-auto border-r border-border py-1 sm:w-72">
            {rooms.map((r) => {
              const on = r.id === active;
              const live = r.last_at && Date.now() - Date.parse(r.last_at) < ACTIVE_WINDOW;
              return (
                <button
                  key={r.id}
                  onClick={() => setActive(r.id)}
                  className={`flex w-full items-start gap-2.5 border-b border-border px-3 py-3 text-left transition sm:px-4 ${
                    on ? "bg-[color:var(--panel)]" : "hover:bg-[color:var(--panel)]"
                  }`}
                >
                  {live ? (
                    <span className="live-dot mt-1.5 shrink-0" />
                  ) : (
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[color:var(--faint)]" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={`mono truncate text-sm ${on ? "text-text" : "text-muted"}`}>{r.name}</span>
                      <span className="mono shrink-0 text-[10px] text-[color:var(--faint)]">{ago(r.last_at)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 text-[11px] text-[color:var(--faint)]">
                      <span className="truncate">{r.last_from ? `${r.last_from}` : "no activity"}</span>
                      <span className="shrink-0">· {r.members}👤</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </aside>

          {/* live timeline */}
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-border px-4 py-3 sm:px-6">
              <div className="flex items-center justify-between gap-2">
                <h2 className="mono flex min-w-0 items-center gap-2 text-sm font-semibold text-text">
                  <span className="truncate">{activeRoom?.name ?? "—"}</span>
                  <span key={tick} className="live-dot shrink-0" title="Live" />
                </h2>
                {activeRoom &&
                  (confirmDelete ? (
                    <span className="flex shrink-0 items-center gap-2 text-xs">
                      <span className="text-muted">Delete room?</span>
                      <button onClick={deleteRoom} disabled={busy} className="text-[color:var(--danger)] hover:opacity-80">
                        {busy ? "Deleting…" : "Delete"}
                      </button>
                      <button onClick={() => setConfirmDelete(false)} className="text-muted hover:text-text">Cancel</button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="btn-ghost shrink-0 px-2.5 py-1 text-[11px] !border-red-500/30 text-[color:var(--danger)] hover:!border-red-400"
                    >
                      Delete room
                    </button>
                  ))}
              </div>

              {/* roster + presence + kick */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {members.length === 0 ? (
                  <span className="text-[11px] text-[color:var(--faint)]">No members yet</span>
                ) : (
                  members.map((mem) => {
                    const online = mem.last_read && Date.now() - Date.parse(mem.last_read) < ACTIVE_WINDOW;
                    return (
                      <span key={mem.id} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px]">
                        {online ? (
                          <span className="live-dot" />
                        ) : (
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--faint)]" />
                        )}
                        <span className="mono text-muted">{mem.name}</span>
                        <button onClick={() => kick(mem.id)} title={`Remove ${mem.name}`} className="ml-0.5 text-[color:var(--faint)] transition hover:text-[color:var(--danger)]">
                          ×
                        </button>
                      </span>
                    );
                  })
                )}
              </div>

              {/* kind filter */}
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    onClick={() => setKind(k)}
                    className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider transition ${
                      kind === k ? "bg-[color:var(--bubble-out-bg)] text-[color:var(--bubble-out-fg)]" : "text-muted hover:text-text"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>

            <div
              ref={listRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
              }}
              className="flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-6"
            >
              {msgs.length > 0 && !noMore && (
                <button
                  onClick={loadOlder}
                  disabled={loadingOlder}
                  className="mx-auto block rounded-full border border-border px-3 py-1 text-xs text-muted transition hover:text-text disabled:opacity-50"
                >
                  {loadingOlder ? "Loading…" : "↑ Load older"}
                </button>
              )}
              {loading && msgs.length === 0 ? (
                <p className="mono text-sm text-[color:var(--faint)]">Loading…</p>
              ) : msgs.length === 0 ? (
                <p className="mono text-sm text-[color:var(--faint)]">
                  Nothing here yet. Connect an agent to this room and its activity will stream in live.
                </p>
              ) : shownMsgs.length === 0 ? (
                <p className="mono text-sm text-[color:var(--faint)]">No {kind} messages.</p>
              ) : (
                shownMsgs.map((m, i) => (
                  <div key={i} className="flex flex-col gap-0.5">
                    <div className="flex items-baseline gap-2">
                      <span className="mono text-xs font-semibold text-text">{m.from}</span>
                      {m.kind && m.kind !== "chat" && (
                        <span className="label rounded border border-border px-1 py-0.5 text-[9px] leading-none">{m.kind}</span>
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
