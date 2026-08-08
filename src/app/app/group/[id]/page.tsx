"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useProfile } from "@/hooks/useProfile";
import { useGroup, type GMsg } from "@/hooks/useGroup";
import { fmtTime } from "@/lib/time";
import Markdown from "@/components/Markdown";
import Poll from "@/components/Poll";

const QUICK = ["❤️", "😂", "👍", "😮", "😢", "🔥"];

export default function GroupPage() {
  const params = useParams();
  const router = useRouter();
  const gid = String(params.id ?? "");
  const { profile, ready } = useProfile();
  const { status, name, memberCount, onlineCount, typingName, messages, send, createPoll, react, setTyping, leave, deleteMessage } =
    useGroup(profile, gid);

  const [draft, setDraft] = useState("");
  const [activeMsg, setActiveMsg] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<GMsg | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // poll creation
  const [pollOpen, setPollOpen] = useState(false);
  const [pollQ, setPollQ] = useState("");
  const [pollOpts, setPollOpts] = useState<string[]>(["", ""]);
  const [pollErr, setPollErr] = useState<string | null>(null);
  const submitPoll = async () => {
    setPollErr(null);
    const res = await createPoll(pollQ, pollOpts);
    if (res.ok) {
      setPollOpen(false);
      setPollQ("");
      setPollOpts(["", ""]);
    } else {
      setPollErr(res.error ?? "Couldn't create the poll.");
    }
  };

  useEffect(() => {
    if (ready && !profile) router.replace("/app");
  }, [ready, profile, router]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, typingName]);

  const onSend = () => {
    if (!draft.trim()) return;
    send(draft, replyTo?.id);
    setDraft("");
    setReplyTo(null);
  };
  const onLeave = async () => {
    if (!window.confirm(`Leave "${name}"? You'll stop receiving its messages.`)) return;
    if (await leave()) router.replace("/app");
  };

  if (!ready || !profile) return <main className="min-h-dvh" />;

  return (
    <main className="mx-auto flex h-dvh w-full max-w-2xl flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <Link href="/app" className="text-sm text-muted transition hover:text-text">
          ← Chats
        </Link>
        <div className="min-w-0 text-center">
          <div className="truncate text-sm font-semibold">{name || "Group"}</div>
          <div className="mono text-xs text-muted">
            {typingName ? `@${typingName} is typing…` : `${memberCount} members · ${onlineCount} online`}
          </div>
        </div>
        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="More options"
            className="px-2 text-lg leading-none text-muted transition hover:text-text"
          >
            ⋯
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-9 z-20 w-40 overflow-hidden rounded-lg border border-border bg-[color:var(--panel)] text-sm shadow-xl">
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onLeave();
                  }}
                  className="block w-full px-4 py-2.5 text-left text-[color:var(--danger)] transition hover:bg-red-500/10"
                >
                  Leave group
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-4">
        {status === "loading" && <p className="mt-8 text-center text-sm text-muted">Loading group…</p>}
        {status === "denied" && (
          <div className="mt-10 text-center">
            <p className="text-muted">You&apos;re not a member of this group.</p>
            <Link href="/app" className="btn mt-5 inline-flex">
              ← Back to chats
            </Link>
          </div>
        )}
        {status === "ready" && messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <p className="mono text-muted">This is the start of {name}.</p>
            <p className="text-sm text-[color:var(--faint)]">Say hi to the group 👋</p>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`flex flex-col ${m.mine ? "items-end" : "items-start"}`}>
            {!m.mine && <span className="mono mb-0.5 px-1 text-[11px] text-muted">@{m.senderName}</span>}
            {m.reply && (
              <div className="mb-1 max-w-[78%] rounded-lg border-l-2 border-[color:var(--border-strong)] bg-[color:var(--panel)] px-2.5 py-1">
                <span className="mono text-[11px] text-muted">{m.reply.author}</span>
                <span className="block max-w-[16rem] truncate text-xs text-[color:var(--faint)]">{m.reply.snippet}</span>
              </div>
            )}
            {m.pollId ? (
              <div className="msg-in max-w-[78%] rounded-2xl border border-border bg-[color:var(--panel)] p-3">
                <Poll pollId={m.pollId} me={profile?.id ?? ""} />
              </div>
            ) : (
              <button
                onClick={() => setActiveMsg(activeMsg === m.id ? null : m.id)}
                className={`msg-in block max-w-[78%] break-words rounded-2xl px-4 py-2.5 text-left text-[15px] leading-snug ${
                  m.mine ? "bg-[color:var(--bubble-out-bg)] text-[color:var(--bubble-out-fg)]" : "border border-border bg-[color:var(--panel)] text-text"
                }`}
              >
                <Markdown text={m.body} />
              </button>
            )}

            {m.reactions.length > 0 && (
              <div className={`mt-0.5 flex gap-1 ${m.mine ? "self-end" : "self-start"}`}>
                {m.reactions.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => r.mine && react(m.id, r.emoji)}
                    className={`rounded-full border px-1.5 py-0.5 text-xs ${
                      r.mine
                        ? "border-[color:var(--border-strong)] bg-[color:var(--panel-2)]"
                        : "border-border bg-[color:var(--panel)]"
                    }`}
                  >
                    {r.emoji}
                  </button>
                ))}
              </div>
            )}

            {activeMsg === m.id && (
              <span className={`mono mt-1 text-[10px] text-[color:var(--faint)] ${m.mine ? "self-end" : "self-start"}`}>
                {m.mine ? "Sent" : `@${m.senderName}`} · {fmtTime(m.created_at)}
              </span>
            )}

            {activeMsg === m.id && (
              <div
                className={`mt-1 flex items-center gap-0.5 rounded-full border border-border bg-[color:var(--panel)] px-1.5 py-1 ${
                  m.mine ? "self-end" : "self-start"
                }`}
              >
                {QUICK.map((e) => (
                  <button
                    key={e}
                    onClick={() => {
                      react(m.id, e);
                      setActiveMsg(null);
                    }}
                    className="rounded-full px-1.5 py-0.5 text-base transition hover:bg-[color:var(--border)]"
                  >
                    {e}
                  </button>
                ))}
                <span className="mx-1 h-4 w-px bg-[color:var(--border-strong)]" />
                <button
                  onClick={() => {
                    setReplyTo(m);
                    setActiveMsg(null);
                  }}
                  className="px-2 text-xs text-muted transition hover:text-text"
                >
                  Reply
                </button>
                {m.mine && (
                  <>
                    <span className="mx-1 h-4 w-px bg-[color:var(--border-strong)]" />
                    <button
                      onClick={() => {
                        deleteMessage(m.id);
                        setActiveMsg(null);
                      }}
                      className="px-2 text-xs text-[color:var(--danger)] transition hover:opacity-80"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}

        {typingName && (
          <div className="msg-in self-start rounded-2xl border border-border bg-[color:var(--panel)] px-4 py-3">
            <span className="typing-dots flex gap-1">
              <i /> <i /> <i />
            </span>
          </div>
        )}
      </div>

      {replyTo && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs">
          <span className="min-w-0 truncate text-muted">
            Replying to {replyTo.mine ? "yourself" : `@${replyTo.senderName}`}:{" "}
            <span className="text-[color:var(--faint)]">{replyTo.body}</span>
          </span>
          <button onClick={() => setReplyTo(null)} className="ml-3 shrink-0 text-muted hover:text-text">
            ✕
          </button>
        </div>
      )}

      <div className="pb-safe flex items-center gap-2 border-t border-border px-3 pt-3">
        <button
          onClick={() => setPollOpen(true)}
          disabled={status !== "ready"}
          title="Create a poll"
          aria-label="Create a poll"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-border text-muted transition hover:border-[color:var(--accent)] hover:text-text disabled:opacity-40"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <line x1="6" y1="20" x2="6" y2="12" />
            <line x1="12" y1="20" x2="12" y2="6" />
            <line x1="18" y1="20" x2="18" y2="14" />
          </svg>
        </button>
        <input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setTyping(true);
          }}
          onKeyDown={(e) => e.key === "Enter" && onSend()}
          disabled={status !== "ready"}
          maxLength={2000}
          placeholder={status === "ready" ? `Message ${name}…` : "…"}
          className="mono min-w-0 flex-1 rounded-full border border-border bg-[color:var(--panel)] px-4 py-3 text-[15px] outline-none placeholder:text-[color:var(--faint)] focus:border-[color:var(--focus)] disabled:opacity-50"
        />
        <button
          onClick={onSend}
          disabled={status !== "ready" || !draft.trim()}
          className="btn shrink-0 px-5 py-3 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </div>

      {/* create poll */}
      {pollOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm" onClick={() => setPollOpen(false)}>
          <div className="w-full max-w-md rounded-lg border border-border bg-[color:var(--panel)] p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="label">Create a poll</p>
              <button onClick={() => setPollOpen(false)} className="text-muted transition hover:text-text">✕</button>
            </div>
            <input
              value={pollQ}
              onChange={(e) => setPollQ(e.target.value)}
              maxLength={120}
              placeholder="Question (e.g. Where for dinner?)"
              className="mono mt-3 w-full rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 py-2.5 text-sm outline-none placeholder:text-[color:var(--faint)] focus:border-[color:var(--focus)]"
            />
            <div className="mt-2 flex flex-col gap-2">
              {pollOpts.map((o, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={o}
                    onChange={(e) => setPollOpts((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))}
                    maxLength={60}
                    placeholder={`Option ${i + 1}`}
                    className="mono min-w-0 flex-1 rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 py-2 text-sm outline-none placeholder:text-[color:var(--faint)] focus:border-[color:var(--focus)]"
                  />
                  {pollOpts.length > 2 && (
                    <button onClick={() => setPollOpts((arr) => arr.filter((_, j) => j !== i))} className="shrink-0 text-xs text-[color:var(--faint)] transition hover:text-[color:var(--danger)]">✕</button>
                  )}
                </div>
              ))}
            </div>
            {pollOpts.length < 5 && (
              <button onClick={() => setPollOpts((arr) => [...arr, ""])} className="mt-2 text-xs text-muted transition hover:text-text">+ Add option</button>
            )}
            {pollErr && <p className="mt-2 text-xs text-[color:var(--danger)]">{pollErr}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setPollOpen(false)} className="btn-ghost px-4 py-2 text-sm">Cancel</button>
              <button
                onClick={submitPoll}
                disabled={!pollQ.trim() || pollOpts.filter((o) => o.trim()).length < 2}
                className="btn px-4 py-2 text-sm disabled:opacity-40"
              >
                Create poll
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
