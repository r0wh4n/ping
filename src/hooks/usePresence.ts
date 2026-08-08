"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

/**
 * Global online presence keyed by profile id. Everyone signed in joins one
 * shared channel; returns the set of currently-online profile ids.
 */
export function usePresence(myId: string | null): Set<string> {
  const [online, setOnline] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!myId) return;
    const ch = supabase.channel("presence:users", {
      config: { presence: { key: myId } },
    });
    ch.on("presence", { event: "sync" }, () => {
      setOnline(new Set(Object.keys(ch.presenceState())));
    }).subscribe((s) => {
      if (s === "SUBSCRIBED") ch.track({ at: Date.now() });
    });
    return () => {
      supabase.removeChannel(ch);
    };
  }, [myId]);

  return online;
}
