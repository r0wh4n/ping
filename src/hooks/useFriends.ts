"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { normalizeUsername } from "@/lib/username";
import type { Profile } from "@/hooks/useProfile";

export type Person = { id: string; username: string; status?: string };
export type Request = { friendshipId: string; person: Person };

type Friendship = {
  id: string;
  requester: string;
  addressee: string;
  status: "pending" | "accepted" | "declined";
};

// Nudge another user's inbox so their lists refresh live.
async function nudge(userId: string) {
  const ch = supabase.channel(`inbox:${userId}`);
  await ch.subscribe();
  ch.send({ type: "broadcast", event: "refresh", payload: {} });
  setTimeout(() => supabase.removeChannel(ch), 600);
}

export function useFriends(profile: Profile | null) {
  const me = profile?.id ?? null;
  const [friends, setFriends] = useState<Person[]>([]);
  const [incoming, setIncoming] = useState<Request[]>([]);
  const [outgoing, setOutgoing] = useState<Request[]>([]);
  const [loading, setLoading] = useState(false);

  const resolve = useCallback(async (ids: string[]): Promise<Record<string, Person>> => {
    if (ids.length === 0) return {};
    const { data } = await supabase.from("profiles").select("id,username,status").in("id", ids);
    const map: Record<string, Person> = {};
    (data ?? []).forEach((p) => {
      map[String(p.id)] = {
        id: String(p.id),
        username: String(p.username),
        status: p.status ? String(p.status) : "",
      };
    });
    return map;
  }, []);

  const refresh = useCallback(async () => {
    if (!me) return;
    setLoading(true);
    const { data } = await supabase
      .from("friendships")
      .select("*")
      .or(`requester.eq.${me},addressee.eq.${me}`);
    const rows = (data ?? []) as Friendship[];

    const otherIds = new Set<string>();
    rows.forEach((f) => otherIds.add(f.requester === me ? f.addressee : f.requester));
    const people = await resolve([...otherIds]);

    const nextFriends: Person[] = [];
    const nextIncoming: Request[] = [];
    const nextOutgoing: Request[] = [];

    for (const f of rows) {
      const otherId = f.requester === me ? f.addressee : f.requester;
      const person = people[otherId];
      if (!person) continue;
      if (f.status === "accepted") nextFriends.push(person);
      else if (f.status === "pending" && f.addressee === me)
        nextIncoming.push({ friendshipId: f.id, person });
      else if (f.status === "pending" && f.requester === me)
        nextOutgoing.push({ friendshipId: f.id, person });
    }

    setFriends(nextFriends);
    setIncoming(nextIncoming);
    setOutgoing(nextOutgoing);
    setLoading(false);
  }, [me, resolve]);

  // initial load + live refresh via personal inbox channel
  useEffect(() => {
    if (!me) return;
    refresh();
    const ch = supabase
      .channel(`inbox:${me}`)
      .on("broadcast", { event: "refresh" }, () => refresh())
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [me, refresh]);

  const addByHandle = useCallback(
    async (input: string): Promise<{ ok: boolean; error?: string; note?: string }> => {
      if (!me || !profile) return { ok: false, error: "Not signed in." };
      const uname = normalizeUsername(input);
      if (!uname) return { ok: false, error: "Enter a handle." };
      if (uname === profile.username) return { ok: false, error: "That's you 🙂" };

      const { data: target } = await supabase
        .from("profiles")
        .select("id,username")
        .eq("username", uname)
        .maybeSingle();
      if (!target) return { ok: false, error: `No one goes by @${uname}.` };
      const targetId = String(target.id);

      const { data: existingRows } = await supabase
        .from("friendships")
        .select("*")
        .or(
          `and(requester.eq.${me},addressee.eq.${targetId}),and(requester.eq.${targetId},addressee.eq.${me})`
        );
      const existing = (existingRows ?? []) as Friendship[];

      const accepted = existing.find((f) => f.status === "accepted");
      if (accepted) return { ok: false, error: `You're already friends with @${uname}.` };

      // They already requested you → accept it instead of duplicating.
      const theirPending = existing.find(
        (f) => f.status === "pending" && f.requester === targetId
      );
      if (theirPending) {
        await supabase.from("friendships").update({ status: "accepted" }).eq("id", theirPending.id);
        await refresh();
        nudge(targetId);
        return { ok: true, note: `You and @${uname} are now friends! 🎉` };
      }

      const myPending = existing.find((f) => f.status === "pending" && f.requester === me);
      if (myPending) return { ok: false, error: `Request to @${uname} already sent.` };

      const { error } = await supabase
        .from("friendships")
        .insert({ requester: me, addressee: targetId, status: "pending" });
      if (error) {
        if (error.code === "42P01")
          return { ok: false, error: "Backend isn't set up yet — run the schema SQL." };
        return { ok: false, error: error.message };
      }
      await refresh();
      nudge(targetId);
      return { ok: true, note: `Request sent to @${uname}.` };
    },
    [me, profile, refresh]
  );

  const respond = useCallback(
    async (req: Request, accept: boolean) => {
      await supabase
        .from("friendships")
        .update({ status: accept ? "accepted" : "declined" })
        .eq("id", req.friendshipId);
      await refresh();
      nudge(req.person.id);
    },
    [refresh]
  );

  // Delete the friendship in either direction — unfriend, cancel a request,
  // or decline. Also clears the DM history between the two (RLS lets each
  // party delete messages they sent or received).
  const removeFriend = useCallback(
    async (person: Person) => {
      if (!me) return;
      await supabase
        .from("friendships")
        .delete()
        .or(
          `and(requester.eq.${me},addressee.eq.${person.id}),and(requester.eq.${person.id},addressee.eq.${me})`
        );
      await supabase
        .from("messages")
        .delete()
        .or(
          `and(sender.eq.${me},recipient.eq.${person.id}),and(sender.eq.${person.id},recipient.eq.${me})`
        );
      await refresh();
      nudge(person.id);
    },
    [me, refresh]
  );

  return { friends, incoming, outgoing, loading, refresh, addByHandle, respond, removeFriend };
}
