"use client";

import { useEffect, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

/**
 * Global online presence keyed by profile id. Everyone signed in joins one
 * shared `presence:users` channel and returns the set of online profile ids.
 *
 * The channel is a module-level singleton, ref-counted across every caller, so
 * mounting this hook in the /app layout keeps the user tracked as online on
 * EVERY page (friends list, DM threads, groups) — not just the friends list.
 * Otherwise a friend actively chatting in a DM would show up as "offline".
 */
let shared: RealtimeChannel | null = null;
let refs = 0;
let onlineIds = new Set<string>();
const listeners = new Set<(ids: Set<string>) => void>();

function ensureChannel(myId: string) {
  if (shared) return;
  const ch = supabase.channel("presence:users", { config: { presence: { key: myId } } });
  ch.on("presence", { event: "sync" }, () => {
    onlineIds = new Set(Object.keys(ch.presenceState()));
    listeners.forEach((l) => l(onlineIds));
  }).subscribe((s) => {
    if (s === "SUBSCRIBED") ch.track({ at: Date.now() });
  });
  shared = ch;
}

export function usePresence(myId: string | null): Set<string> {
  const [online, setOnline] = useState<Set<string>>(onlineIds);

  useEffect(() => {
    if (!myId) return;
    ensureChannel(myId);
    refs++;
    const listener = (ids: Set<string>) => setOnline(ids);
    listeners.add(listener);
    setOnline(onlineIds); // seed with whatever the shared channel already knows

    return () => {
      listeners.delete(listener);
      refs -= 1;
      if (refs <= 0 && shared) {
        supabase.removeChannel(shared);
        shared = null;
        onlineIds = new Set();
      }
    };
  }, [myId]);

  return online;
}
