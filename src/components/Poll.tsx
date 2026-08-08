"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// A group-chat poll. Self-contained: reads the poll + its votes (members-only via
// RLS), renders result bars, and lets you vote/change. Counts refresh on your
// vote and on mount (cross-user live vote sync is a later enhancement).
export default function Poll({ pollId, me }: { pollId: string; me: string }) {
  const [poll, setPoll] = useState<{ question: string; options: string[] } | null>(null);
  const [counts, setCounts] = useState<number[]>([]);
  const [myChoice, setMyChoice] = useState<number | null>(null);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    const { data: p } = await supabase.from("polls").select("question, options").eq("id", pollId).maybeSingle();
    if (!p) return;
    const options = Array.isArray(p.options) ? p.options.map(String) : [];
    setPoll({ question: String(p.question), options });
    const { data: votes } = await supabase.from("poll_votes").select("voter, choice").eq("poll_id", pollId);
    const c = new Array(options.length).fill(0) as number[];
    let mine: number | null = null;
    (votes ?? []).forEach((v) => {
      const idx = Number(v.choice);
      if (idx >= 0 && idx < c.length) c[idx]++;
      if (String(v.voter) === me) mine = idx;
    });
    setCounts(c);
    setMyChoice(mine);
    setTotal((votes ?? []).length);
  }, [pollId, me]);

  useEffect(() => {
    load();
  }, [load]);

  const vote = async (choice: number) => {
    setMyChoice(choice); // optimistic
    await supabase.from("poll_votes").upsert({ poll_id: pollId, voter: me, choice }, { onConflict: "poll_id,voter" });
    load();
  };

  if (!poll) return <div className="w-64 text-xs text-muted">Loading poll…</div>;

  return (
    <div className="w-64 max-w-full">
      <p className="mono text-sm font-bold leading-snug">{poll.question}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        {poll.options.map((opt, i) => {
          const n = counts[i] ?? 0;
          const pct = total ? Math.round((n / total) * 100) : 0;
          const picked = myChoice === i;
          return (
            <button
              key={i}
              onClick={() => vote(i)}
              className="relative overflow-hidden rounded-lg border border-border px-3 py-2 text-left text-sm transition hover:border-[color:var(--accent)]"
            >
              <span className="absolute inset-y-0 left-0 bg-[color:var(--border)]" style={{ width: `${pct}%` }} aria-hidden />
              <span className="relative flex items-center justify-between gap-2">
                <span className="truncate">
                  {picked && <span className="mr-1">●</span>}
                  {opt}
                </span>
                <span className="shrink-0 text-xs text-muted">{pct}%</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-[color:var(--faint)]">
        {total} vote{total === 1 ? "" : "s"} · tap to vote or change
      </p>
    </div>
  );
}
