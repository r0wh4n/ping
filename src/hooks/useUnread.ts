"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Profile } from "@/hooks/useProfile";

/**
 * Unread message counts per friend for the home list. Seeded from the
 * `unread_counts()` RPC, bumped live via the personal `unread:<me>` broadcast
 * channel (senders poke it on send), and re-synced when the tab regains focus.
 */
export function useUnread(profile: Profile | null) {
  const me = profile?.id ?? null;
  const [counts, setCounts] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    if (!me) return;
    const { data } = await supabase.rpc("unread_counts");
    const next: Record<string, number> = {};
    (data ?? []).forEach((r: { other: string; n: number }) => {
      next[String(r.other)] = Number(r.n);
    });
    setCounts(next);
  }, [me]);

  useEffect(() => {
    if (!me) return;
    refresh();
    const ch = supabase
      .channel(`unread:${me}`)
      .on("broadcast", { event: "ping" }, ({ payload }) => {
        const from = payload?.from ? String(payload.from) : null;
        if (from) setCounts((c) => ({ ...c, [from]: (c[from] ?? 0) + 1 }));
      })
      .subscribe();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      supabase.removeChannel(ch);
      window.removeEventListener("focus", onFocus);
    };
  }, [me, refresh]);

  // Optimistically clear a friend's badge (the DB thread_reads row is written
  // by useDM when the thread opens; focus-refresh reconciles).
  const clear = useCallback((otherId: string) => {
    setCounts((c) => {
      if (!c[otherId]) return c;
      const next = { ...c };
      delete next[otherId];
      return next;
    });
  }, []);

  return { counts, refresh, clear };
}
