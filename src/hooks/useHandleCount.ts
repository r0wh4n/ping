"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

/**
 * Total number of @handles claimed on Ping (all-time). profiles is
 * world-readable, so a head+count query is enough. Returns null while loading.
 */
export function useHandleCount() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    supabase
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .then(({ count }) => setCount(count ?? 0));
  }, []);

  return count;
}
