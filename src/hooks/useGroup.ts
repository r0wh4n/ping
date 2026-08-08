"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { cleanText } from "@/lib/profanity";
import type { Profile } from "@/hooks/useProfile";
import type { Reaction } from "@/hooks/useDM";

export type GMsg = {
  id: string;
  mine: boolean;
  senderName: string; // @handle of the author (for labels on group bubbles)
  body: string;
  created_at: string;
  reply?: { author: string; snippet: string } | null;
  reactions: Reaction[];
  pollId?: string | null;
};
type Status = "loading" | "ready" | "denied";

const setReaction = (list: Reaction[], mine: boolean, emoji: string | null): Reaction[] => {
  const others = list.filter((r) => r.mine !== mine);
  return emoji ? [...others, { emoji, mine }] : others;
};

/**
 * A group thread. History from `messages` (group_id set, members-only via RLS);
 * live delivery + typing + presence ride a shared `group:<id>` broadcast channel.
 * Text + reactions + replies only (media/voice are 1:1-only for now).
 */
export function useGroup(profile: Profile | null, groupId: string) {
  const me = profile?.id ?? null;
  const [status, setStatus] = useState<Status>("loading");
  const [name, setName] = useState("");
  const [memberCount, setMemberCount] = useState(0);
  const [onlineCount, setOnlineCount] = useState(1);
  const [typingName, setTypingName] = useState<string | null>(null);
  const [messages, setMessages] = useState<GMsg[]>([]);

  const channel = useRef<RealtimeChannel | null>(null);
  const names = useRef<Record<string, string>>({}); // id -> @handle
  const msgsRef = useRef<GMsg[]>([]);
  const typingSent = useRef(0);
  const typingClear = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    msgsRef.current = messages;
  }, [messages]);

  const label = useCallback((id: string) => names.current[id] ?? "someone", []);

  useEffect(() => {
    if (!me || !groupId) return;
    let cancelled = false;

    (async () => {
      const { data: g } = await supabase.from("groups").select("name").eq("id", groupId).maybeSingle();
      if (cancelled) return;
      if (!g) {
        setStatus("denied"); // not a member (RLS) or missing
        return;
      }
      setName(String(g.name));

      const { data: gm } = await supabase.from("group_members").select("user_id").eq("group_id", groupId);
      const ids = (gm ?? []).map((r) => String(r.user_id));
      setMemberCount(ids.length);
      const { data: profs } = await supabase.from("profiles").select("id,username").in("id", ids.length ? ids : [me]);
      const map: Record<string, string> = {};
      (profs ?? []).forEach((p) => (map[String(p.id)] = String(p.username)));
      names.current = map;

      const { data: hist } = await supabase
        .from("messages")
        .select("id,sender,body,reply_to,created_at,poll_id")
        .eq("group_id", groupId)
        .order("created_at", { ascending: true })
        .limit(300);
      if (cancelled) return;
      const rows = hist ?? [];
      const byId = new Map(rows.map((r) => [String(r.id), r]));

      const ids2 = rows.map((r) => String(r.id));
      const reactMap = new Map<string, Reaction[]>();
      if (ids2.length) {
        const { data: reacts } = await supabase
          .from("message_reactions")
          .select("message_id,user_id,emoji")
          .in("message_id", ids2);
        (reacts ?? []).forEach((r) => {
          const k = String(r.message_id);
          const l = reactMap.get(k) ?? [];
          l.push({ emoji: String(r.emoji), mine: String(r.user_id) === me });
          reactMap.set(k, l);
        });
      }

      setMessages(
        rows.map((m) => {
          const parent = m.reply_to ? byId.get(String(m.reply_to)) : null;
          return {
            id: String(m.id),
            mine: m.sender === me,
            senderName: label(String(m.sender)),
            body: cleanText(String(m.body ?? "")),
            created_at: String(m.created_at),
            reply: parent
              ? {
                  author: parent.sender === me ? "You" : `@${label(String(parent.sender))}`,
                  snippet: cleanText(String(parent.body ?? "")).slice(0, 80),
                }
              : null,
            reactions: reactMap.get(String(m.id)) ?? [],
            pollId: m.poll_id ? String(m.poll_id) : null,
          };
        })
      );
      setStatus("ready");

      const ch = supabase.channel(`group:${groupId}`, { config: { presence: { key: me } } });
      ch.on("broadcast", { event: "msg" }, ({ payload }) => {
        if (payload?.sender === me) return;
        setTypingName(null);
        setMessages((m) => [
          ...m,
          {
            id: String(payload.id),
            mine: false,
            senderName: label(String(payload.sender)),
            body: cleanText(String(payload.body ?? "")),
            created_at: String(payload.created_at),
            reply: payload?.reply ?? null,
            reactions: [],
            pollId: payload?.pollId ?? null,
          },
        ]);
      })
        .on("broadcast", { event: "react" }, ({ payload }) => {
          if (payload?.sender === me) return;
          const emoji = payload?.emoji ? String(payload.emoji) : null;
          setMessages((list) =>
            list.map((m) => (m.id === String(payload?.messageId) ? { ...m, reactions: setReaction(m.reactions, false, emoji) } : m))
          );
        })
        .on("broadcast", { event: "typing" }, ({ payload }) => {
          if (payload?.sender === me) return;
          setTypingName(payload?.typing ? String(payload?.name ?? "someone") : null);
        })
        .on("broadcast", { event: "del" }, ({ payload }) => {
          const id = String(payload?.id ?? "");
          setMessages((m) => m.filter((x) => x.id !== id));
        })
        .on("presence", { event: "sync" }, () => setOnlineCount(Object.keys(ch.presenceState()).length))
        .subscribe((s) => {
          if (s === "SUBSCRIBED") ch.track({ id: me });
        });
      channel.current = ch;
    })();

    return () => {
      cancelled = true;
      if (channel.current) {
        supabase.removeChannel(channel.current);
        channel.current = null;
      }
    };
  }, [me, groupId, label]);

  const send = useCallback(
    async (text: string, replyToId?: string | null) => {
      const body = text.trim();
      if (!body || !me) return;
      const parent = replyToId ? msgsRef.current.find((m) => m.id === replyToId) : null;
      const reply = parent
        ? { author: parent.mine ? "You" : `@${parent.senderName}`, snippet: parent.body.slice(0, 80) }
        : null;
      const { data, error } = await supabase
        .from("messages")
        .insert({ sender: me, group_id: groupId, body, reply_to: replyToId ?? null })
        .select()
        .single();
      if (error || !data) return;
      const myName = names.current[me] ?? "you";
      setMessages((m) => [
        ...m,
        {
          id: String(data.id),
          mine: true,
          senderName: myName,
          body: cleanText(body),
          created_at: String(data.created_at),
          reply,
          reactions: [],
        },
      ]);
      channel.current?.send({
        type: "broadcast",
        event: "msg",
        payload: { id: data.id, sender: me, body, created_at: data.created_at, reply },
      });
    },
    [me, groupId]
  );

  const createPoll = useCallback(
    async (question: string, options: string[]) => {
      const q = question.trim();
      const opts = options.map((o) => o.trim()).filter(Boolean);
      if (!me || !q || opts.length < 2) return { ok: false, error: "Add a question and at least 2 options." };
      const { data: poll, error: pErr } = await supabase
        .from("polls")
        .insert({ group_id: groupId, creator: me, question: q, options: opts })
        .select("id")
        .single();
      if (pErr || !poll) return { ok: false, error: "Couldn't create the poll." };
      const body = "📊 " + q;
      const { data, error } = await supabase
        .from("messages")
        .insert({ sender: me, group_id: groupId, body, poll_id: poll.id })
        .select()
        .single();
      if (error || !data) return { ok: false, error: "Couldn't post the poll." };
      const myName = names.current[me] ?? "you";
      setMessages((m) => [
        ...m,
        { id: String(data.id), mine: true, senderName: myName, body: cleanText(body), created_at: String(data.created_at), reply: null, reactions: [], pollId: String(poll.id) },
      ]);
      channel.current?.send({
        type: "broadcast",
        event: "msg",
        payload: { id: data.id, sender: me, body, created_at: data.created_at, reply: null, pollId: poll.id },
      });
      return { ok: true };
    },
    [me, groupId]
  );

  const react = useCallback(
    async (messageId: string, emoji: string) => {
      if (!me) return;
      const msg = msgsRef.current.find((m) => m.id === messageId);
      const current = msg?.reactions.find((r) => r.mine)?.emoji ?? null;
      const removed = current === emoji;
      setMessages((list) =>
        list.map((m) => (m.id === messageId ? { ...m, reactions: setReaction(m.reactions, true, removed ? null : emoji) } : m))
      );
      if (removed) {
        await supabase.from("message_reactions").delete().eq("message_id", messageId).eq("user_id", me);
      } else {
        await supabase
          .from("message_reactions")
          .upsert({ message_id: messageId, user_id: me, emoji }, { onConflict: "message_id,user_id" });
      }
      channel.current?.send({ type: "broadcast", event: "react", payload: { messageId, sender: me, emoji: removed ? null : emoji } });
    },
    [me]
  );

  const setTyping = useCallback(
    (typing: boolean) => {
      if (!channel.current || !me) return;
      const now = Date.now();
      if (typing && now - typingSent.current > 700) {
        typingSent.current = now;
        channel.current.send({ type: "broadcast", event: "typing", payload: { sender: me, name: names.current[me], typing: true } });
        if (typingClear.current) clearTimeout(typingClear.current);
        typingClear.current = setTimeout(
          () => channel.current?.send({ type: "broadcast", event: "typing", payload: { sender: me, typing: false } }),
          1500
        );
      }
    },
    [me]
  );

  const leave = useCallback(async (): Promise<boolean> => {
    if (!me) return false;
    const { error } = await supabase.from("group_members").delete().eq("group_id", groupId).eq("user_id", me);
    return !error;
  }, [me, groupId]);

  // Delete one of your own group messages for everyone (RLS: sender only).
  const deleteMessage = useCallback(
    async (id: string) => {
      if (!me) return;
      await supabase.from("messages").delete().eq("id", id);
      setMessages((m) => m.filter((x) => x.id !== id));
      channel.current?.send({ type: "broadcast", event: "del", payload: { id } });
    },
    [me]
  );

  return { status, name, memberCount, onlineCount, typingName, messages, send, createPoll, react, setTyping, leave, deleteMessage };
}
