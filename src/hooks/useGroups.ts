"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Profile } from "@/hooks/useProfile";
import { provisionGroupKey } from "@/lib/groupKeys";

export type GroupRow = { id: string; name: string; count: number };

/** Lists the groups the caller belongs to (RLS returns member groups only). */
export function useGroups(profile: Profile | null) {
  const me = profile?.id ?? null;
  const [groups, setGroups] = useState<GroupRow[]>([]);

  const refresh = useCallback(async () => {
    if (!me) return;
    const { data } = await supabase
      .from("groups")
      .select("id,name,group_members(count)")
      .order("created_at", { ascending: false });
    setGroups(
      (data ?? []).map((g) => ({
        id: String(g.id),
        name: String(g.name),
        count: Number((g.group_members as { count: number }[] | undefined)?.[0]?.count ?? 0),
      }))
    );
  }, [me]);

  useEffect(() => {
    if (me) refresh();
  }, [me, refresh]);

  const createGroup = useCallback(
    async (name: string, memberIds: string[]): Promise<{ ok: boolean; id?: string }> => {
      const { data, error } = await supabase.rpc("create_group", { name: name.trim(), members: memberIds });
      if (error || !data) return { ok: false };
      const id = String(data);
      // Mint the group's E2E key and seal it to everyone, creator included.
      // If this can't run (locked identity) the group simply stays plaintext.
      if (me) await provisionGroupKey(id, [me, ...memberIds]);
      await refresh();
      return { ok: true, id };
    },
    [refresh, me]
  );

  return { groups, refresh, createGroup };
}
