"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

/**
 * Tracks the real number of people currently on the site via a shared
 * presence channel. Returns null while connecting.
 */
export function useOnlineCount() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    const id = crypto.randomUUID();
    const channel = supabase.channel("online", {
      config: { presence: { key: id } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        setCount(Object.keys(channel.presenceState()).length);
      })
      .subscribe((s) => {
        if (s === "SUBSCRIBED") channel.track({ at: Date.now() });
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return count;
}
