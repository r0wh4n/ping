"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useProfile } from "@/hooks/useProfile";
import { useFriends } from "@/hooks/useFriends";
import { usePresence } from "@/hooks/usePresence";
import { supabase } from "@/lib/supabase";
import { normalizeUsername } from "@/lib/username";

type Target = { id: string; username: string; status: string };

export default function ProfileClient({ username }: { username: string }) {
  const uname = normalizeUsername(username);
  const { profile, ready } = useProfile();
  const { friends, outgoing, addByHandle } = useFriends(profile);

  const [target, setTarget] = useState<Target | null | undefined>(undefined); // undefined = loading
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    supabase
      .from("profiles")
      .select("id,username,status")
      .eq("username", uname)
      .maybeSingle()
      .then(({ data }) => {
        if (!live) return;
        setTarget(
          data
            ? { id: String(data.id), username: String(data.username), status: data.status ? String(data.status) : "" }
            : null
        );
      });
    return () => {
      live = false;
    };
  }, [uname]);

  // Join presence as *myself* (never as the target) and check if they're online.
  const online = usePresence(profile?.id ?? null);
  const isOnline = target ? online.has(target.id) : false;
  const isSelf = ready && profile?.username === uname;
  const isFriend = friends.some((f) => f.username === uname);
  const isPending = outgoing.some((o) => o.person.username === uname);

  const add = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    const res = await addByHandle(uname);
    if (res.ok) setNote(res.note ?? "Done!");
    else setErr(res.error ?? "Something went wrong.");
    setBusy(false);
  };

  return (
    <main className="flex min-h-dvh flex-col">
      <nav className="wrap flex items-center justify-between py-4">
        <Link href="/" className="mono text-[15px] font-semibold">
          ping<span className="text-[color:var(--faint)]">.chat</span>
        </Link>
        {ready && !profile && (
          <Link href="/app" className="text-sm text-muted transition hover:text-text">
            Log in
          </Link>
        )}
      </nav>

      <div className="flex flex-1 items-center justify-center px-6 py-8">
        {target === undefined ? (
          <div className="idcard w-full max-w-md animate-pulse text-muted">Loading…</div>
        ) : target === null ? (
          <div className="idcard w-full max-w-md text-center">
            <p className="label">NOT FOUND</p>
            <h1 className="mt-4 text-2xl font-semibold tracking-tight">
              No one goes by <span className="mono">@{uname}</span>
            </h1>
            <p className="mt-3 text-sm text-muted">That handle is still up for grabs.</p>
            <Link href="/app" className="btn mt-6 inline-flex">
              Claim it on Ping →
            </Link>
          </div>
        ) : (
          <div className="idcard w-full max-w-md">
            <p className="label">ON PING</p>
            <div className="mt-4 flex items-center gap-2.5">
              <span
                className={isOnline ? "live-dot" : "inline-block h-2 w-2 rounded-full bg-[color:var(--faint)]"}
                title={isOnline ? "online" : "offline"}
              />
              <h1 className="text-2xl font-semibold tracking-tight">
                <span className="gradient-text">@{target.username}</span>
              </h1>
            </div>
            {target.status && <p className="mt-3 text-sm text-muted">“{target.status}”</p>}

            <div className="my-5 hair" />

            {/* CTA depends on who's viewing */}
            {!ready ? (
              <div className="h-11" />
            ) : !profile ? (
              <>
                <Link href={`/app?add=${target.username}`} className="btn w-full justify-center py-3">
                  Add @{target.username} on Ping →
                </Link>
                <p className="mt-3 text-center text-xs text-muted">
                  Ping is a friends-only chat. Claim your <span className="mono text-text">@handle</span> and say hi.
                </p>
              </>
            ) : isSelf ? (
              <>
                <p className="text-sm text-muted">This is you 🙂 Share your link so friends can add you.</p>
                <Link href="/app" className="btn mt-4 w-full justify-center py-3">
                  Go to your Ping →
                </Link>
              </>
            ) : isFriend ? (
              <>
                <p className="mb-4 text-sm text-[color:var(--ok)]">✓ You&apos;re friends on Ping.</p>
                <Link href={`/app/dm/${target.username}`} className="btn w-full justify-center py-3">
                  Message @{target.username} →
                </Link>
              </>
            ) : isPending ? (
              <p className="text-sm text-muted">Request sent — waiting for @{target.username} to accept.</p>
            ) : (
              <button
                onClick={add}
                disabled={busy}
                className="btn w-full justify-center py-3 disabled:opacity-40"
              >
                {busy ? "…" : `Add @${target.username}`}
              </button>
            )}

            {note && <p className="mt-3 text-center text-sm text-[color:var(--ok)]">{note}</p>}
            {err && <p className="mt-3 text-center text-sm text-[color:var(--danger)]">{err}</p>}
          </div>
        )}
      </div>
    </main>
  );
}
