"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useProfile } from "@/hooks/useProfile";
import { useLive } from "@/hooks/useLive";

export default function LivePage() {
  const params = useParams();
  const router = useRouter();
  const handle = String(params.handle ?? "");
  const { profile, ready } = useProfile();
  const { status, messages, hidden, send } = useLive(profile, handle);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ready && !profile) router.replace("/app");
  }, [ready, profile, router]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const onSend = () => {
    if (!draft.trim()) return;
    send(draft);
    setDraft("");
  };

  if (!ready || !profile) return <main className="min-h-dvh" />;

  const live = status === "live";
  const blanked = live && hidden;

  return (
    <main className="mx-auto flex h-dvh w-full max-w-2xl flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <Link href={`/app/dm/${handle}`} className="text-sm text-muted transition hover:text-text">
          ← Chat
        </Link>
        <div className="flex items-center gap-2 text-sm">
          <span className={live ? "live-dot" : "inline-block h-2 w-2 rounded-full bg-[color:var(--faint)]"} />
          <span className="mono font-medium">⚡ Live · @{handle}</span>
        </div>
        <span className="w-10" />
      </header>

      {/* zero-trace banner */}
      <div className="border-b border-border bg-[color:var(--panel)] px-4 py-2 text-center text-xs text-muted">
        🔥 Nothing here is saved — not on any server, not in a backup. It&apos;s gone when either of you leaves.
      </div>

      <div ref={listRef} className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-4">
        {status === "notfound" && (
          <div className="mt-10 text-center">
            <p className="text-muted">
              No one goes by <span className="mono text-text">@{handle}</span>.
            </p>
            <Link href="/app" className="btn mt-5 inline-flex">
              ← Back
            </Link>
          </div>
        )}
        {status === "waiting" && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <span className="live-dot" />
            <p className="mono text-muted">Waiting for @{handle} to come live…</p>
            <p className="text-sm text-[color:var(--faint)]">
              Both of you must be here. The moment starts when they arrive.
            </p>
          </div>
        )}
        {status === "left" && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <p className="mono text-muted">@{handle} left — the moment is gone.</p>
            <p className="text-sm text-[color:var(--faint)]">Nothing was saved. There&apos;s nothing to go back to.</p>
            <Link href={`/app/dm/${handle}`} className="btn mt-2 inline-flex">
              Back to chat
            </Link>
          </div>
        )}

        {live && messages.length === 0 && !blanked && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <p className="mono text-muted">You&apos;re both here. Say something.</p>
            <p className="text-sm text-[color:var(--faint)]">It exists only right now.</p>
          </div>
        )}

        {live &&
          !blanked &&
          messages.map((m) => (
            <div
              key={m.id}
              className={`msg-in max-w-[78%] break-words rounded-2xl px-4 py-2.5 text-[15px] leading-snug ${
                m.mine ? "self-end bg-[color:var(--bubble-out-bg)] text-[color:var(--bubble-out-fg)]" : "self-start border border-border bg-[color:var(--panel)] text-text"
              }`}
            >
              {m.body}
            </div>
          ))}

        {blanked && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <p className="mono text-muted">🙈 Hidden</p>
            <p className="text-sm text-[color:var(--faint)]">Messages show only while you&apos;re looking. Come back.</p>
          </div>
        )}
      </div>

      <div className="pb-safe flex items-center gap-2 border-t border-border px-3 pt-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSend()}
          disabled={!live}
          maxLength={2000}
          placeholder={live ? "say it in the moment…" : "waiting…"}
          className="mono min-w-0 flex-1 rounded-full border border-border bg-[color:var(--panel)] px-4 py-3 text-[15px] outline-none placeholder:text-[color:var(--faint)] focus:border-[color:var(--focus)] disabled:opacity-50"
        />
        <button
          onClick={onSend}
          disabled={!live || !draft.trim()}
          className="btn shrink-0 px-5 py-3 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </main>
  );
}
