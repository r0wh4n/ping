"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { cleanText } from "@/lib/profanity";
import { getIdentity, encryptFor, decryptFrom } from "@/lib/crypto";
import type { Profile } from "@/hooks/useProfile";

export type Reaction = { emoji: string; mine: boolean };
export type ReplyPreview = { fromMe: boolean; snippet: string };
export type DMsg = {
  id: string;
  mine: boolean;
  body: string;
  created_at: string;
  image?: string | null; // signed URL for <img src>
  audio?: string | null; // signed URL for <audio src>
  audioSecs?: number;
  reply?: ReplyPreview | null;
  reactions: Reaction[];
};
type Status = "loading" | "ready" | "notfound";

const PRUNE_EVERY_MS = 30_000;
const SIGNED_TTL = 604800; // 1 week
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const snippetOf = (body: string, image_path?: string | null, audio_path?: string | null) => {
  if (body) return cleanText(body).slice(0, 80);
  if (image_path) return "📷 Photo";
  if (audio_path) return "🎙 Voice message";
  return "";
};

// One reaction per person per message (iMessage-style). Replace this side's.
const setReaction = (list: Reaction[], mine: boolean, emoji: string | null): Reaction[] => {
  const others = list.filter((r) => r.mine !== mine);
  return emoji ? [...others, { emoji, mine }] : others;
};

// Viewer-relative reply preview from an already-decrypted local message.
const replyFromParent = (parent: DMsg | undefined): ReplyPreview | null =>
  parent
    ? {
        fromMe: parent.mine,
        snippet: parent.image && !parent.body ? "📷 Photo" : parent.audio && !parent.body ? "🎙 Voice message" : parent.body.slice(0, 80),
      }
    : null;

/**
 * A 1-on-1 DM thread with a friend. History comes from the `messages` table
 * (persistent); live delivery + typing + presence + reactions ride a shared
 * Broadcast channel `dm:<sorted-pair>`. Supports photos (private `dm-media`
 * bucket, served via signed URLs), tapback reactions, replies, a shared
 * disappearing timer, and a manual "clear chat".
 */
export function useDM(profile: Profile | null, friendUsername: string) {
  const me = profile?.id ?? null;
  const [status, setStatus] = useState<Status>("loading");
  const [messages, setMessages] = useState<DMsg[]>([]);
  const [friendActive, setFriendActive] = useState(false);
  const [friendTyping, setFriendTyping] = useState(false);
  const [friendStatus, setFriendStatus] = useState("");
  const [clearAfter, setClearAfter] = useState(0); // seconds; 0 = off
  const [pinnedId, setPinnedId] = useState<string | null>(null); // pinned message id (shared)
  const [scheduled, setScheduled] = useState<{ id: string; text: string; at: string }[]>([]);

  const friendId = useRef<string | null>(null);
  const peerPub = useRef<string | null>(null); // friend's public key (b64), for E2E
  const channel = useRef<RealtimeChannel | null>(null);
  const clearAfterRef = useRef(0);
  const typingSent = useRef(0);
  const typingOff = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msgsRef = useRef<DMsg[]>([]);
  useEffect(() => {
    msgsRef.current = messages;
  }, [messages]);

  const pairFilter = useCallback(() => {
    const a = me;
    const b = friendId.current;
    return `and(sender.eq.${a},recipient.eq.${b}),and(sender.eq.${b},recipient.eq.${a})`;
  }, [me]);

  const signPath = useCallback(async (path?: string | null): Promise<string | null> => {
    if (!path) return null;
    const { data } = await supabase.storage.from("dm-media").createSignedUrl(path, SIGNED_TTL);
    return data?.signedUrl ?? null;
  }, []);

  // Decrypt an encrypted body with my identity + the friend's public key.
  const decodeBody = useCallback((raw: string, enc?: boolean): string => {
    if (!enc) return raw;
    const id = getIdentity();
    const pub = peerPub.current;
    if (id && pub) {
      const text = decryptFrom(raw, pub, id.sec);
      if (text !== null) return text;
    }
    return "🔒 Encrypted — can't read on this device";
  }, []);

  const applyTimer = useCallback((secs: number) => {
    clearAfterRef.current = secs;
    setClearAfter(secs);
  }, []);

  // Delete messages older than the timer (DB + local view).
  const prune = useCallback(async () => {
    const secs = clearAfterRef.current;
    if (!secs || !me || !friendId.current) return;
    const cutoffMs = Date.now() - secs * 1000;
    await supabase
      .from("messages")
      .delete()
      .or(pairFilter())
      .lt("created_at", new Date(cutoffMs).toISOString());
    setMessages((m) => m.filter((msg) => new Date(msg.created_at).getTime() >= cutoffMs));
  }, [me, pairFilter]);

  // Mark this thread read up to now (drives unread badges on the home list).
  const markRead = useCallback(async () => {
    if (!me || !friendId.current) return;
    await supabase
      .from("thread_reads")
      .upsert(
        { owner: me, other: friendId.current, last_read: new Date().toISOString() },
        { onConflict: "owner,other" }
      );
  }, [me]);

  // Poke the recipient's unread channel so their home badge bumps live.
  const nudgeUnread = useCallback(() => {
    const rid = friendId.current;
    if (!rid || !me) return;
    const ch = supabase.channel(`unread:${rid}`);
    ch.subscribe((s) => {
      if (s === "SUBSCRIBED") {
        ch.send({ type: "broadcast", event: "ping", payload: { from: me } });
        setTimeout(() => supabase.removeChannel(ch), 600);
      }
    });
  }, [me]);

  useEffect(() => {
    if (!me || !friendUsername) return;
    let cancelled = false;

    (async () => {
      const { data: fr } = await supabase
        .from("profiles")
        .select("id,username,status,public_key")
        .eq("username", friendUsername.toLowerCase())
        .maybeSingle();
      if (cancelled) return;
      if (!fr) {
        setStatus("notfound");
        return;
      }
      const fid = String(fr.id);
      friendId.current = fid;
      peerPub.current = fr.public_key ? String(fr.public_key) : null;
      setFriendStatus(fr.status ? String(fr.status) : "");

      const [ua, ub] = [me, fid].sort();

      // Load the shared timer, then prune before showing history.
      const { data: setting } = await supabase
        .from("thread_settings")
        .select("clear_after_seconds, pinned_message_id")
        .eq("user_a", ua)
        .eq("user_b", ub)
        .maybeSingle();
      if (cancelled) return;
      applyTimer(setting?.clear_after_seconds ?? 0);
      setPinnedId(setting?.pinned_message_id ?? null);
      await prune();

      const { data: hist } = await supabase
        .from("messages")
        .select("id,sender,recipient,body,enc,image_path,audio_path,audio_secs,reply_to,created_at")
        .or(pairFilter())
        .order("created_at", { ascending: true })
        .limit(300);
      if (cancelled) return;

      const rows = hist ?? [];
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      // Decrypt bodies once, up front (used for both messages and reply snippets).
      const decoded = new Map(rows.map((r) => [String(r.id), decodeBody(String(r.body ?? ""), Boolean(r.enc))]));

      // Reactions for this whole thread in one query.
      const ids = rows.map((r) => String(r.id));
      const reactMap = new Map<string, Reaction[]>();
      if (ids.length) {
        const { data: reacts } = await supabase
          .from("message_reactions")
          .select("message_id,user_id,emoji")
          .in("message_id", ids);
        (reacts ?? []).forEach((r) => {
          const key = String(r.message_id);
          const list = reactMap.get(key) ?? [];
          list.push({ emoji: String(r.emoji), mine: String(r.user_id) === me });
          reactMap.set(key, list);
        });
      }

      const signedImg = await Promise.all(rows.map((r) => signPath(r.image_path)));
      const signedAud = await Promise.all(rows.map((r) => signPath(r.audio_path)));
      if (cancelled) return;

      setMessages(
        rows.map((m, i) => {
          const parent = m.reply_to ? byId.get(String(m.reply_to)) : null;
          return {
            id: String(m.id),
            mine: m.sender === me,
            body: cleanText(decoded.get(String(m.id)) ?? ""),
            created_at: String(m.created_at),
            image: signedImg[i],
            audio: signedAud[i],
            audioSecs: m.audio_secs ? Number(m.audio_secs) : undefined,
            reply: parent
              ? {
                  fromMe: parent.sender === me,
                  snippet: snippetOf(decoded.get(String(parent.id)) ?? "", parent.image_path, parent.audio_path),
                }
              : null,
            reactions: reactMap.get(String(m.id)) ?? [],
          };
        })
      );
      setStatus("ready");
      markRead();

      const ch = supabase.channel(`dm:${ua}:${ub}`, { config: { presence: { key: me } } });
      ch.on("broadcast", { event: "msg" }, async ({ payload }) => {
        if (payload?.sender === me) return;
        setFriendTyping(false);
        const image = await signPath(payload?.image_path);
        const audio = await signPath(payload?.audio_path);
        const text = cleanText(decodeBody(String(payload.body ?? ""), Boolean(payload?.enc)));
        setMessages((m) => {
          const parent = payload?.reply?.id ? m.find((x) => x.id === String(payload.reply.id)) : undefined;
          return [
            ...m,
            {
              id: String(payload.id),
              mine: false,
              body: text,
              created_at: String(payload.created_at),
              image,
              audio,
              audioSecs: payload?.audio_secs ? Number(payload.audio_secs) : undefined,
              reply: replyFromParent(parent),
              reactions: [],
            },
          ];
        });
        markRead();
      })
        .on("broadcast", { event: "react" }, ({ payload }) => {
          if (payload?.sender === me) return;
          const emoji = payload?.emoji ? String(payload.emoji) : null;
          setMessages((list) =>
            list.map((m) =>
              m.id === String(payload?.messageId)
                ? { ...m, reactions: setReaction(m.reactions, false, emoji) }
                : m
            )
          );
        })
        .on("broadcast", { event: "typing" }, ({ payload }) => {
          if (payload?.sender !== me) setFriendTyping(Boolean(payload?.typing));
        })
        .on("broadcast", { event: "cleared" }, () => setMessages([]))
        .on("broadcast", { event: "del" }, ({ payload }) => {
          const id = String(payload?.id ?? "");
          setMessages((m) => m.filter((x) => x.id !== id));
        })
        .on("broadcast", { event: "timer" }, ({ payload }) => {
          applyTimer(Number(payload?.seconds ?? 0));
          prune();
        })
        .on("broadcast", { event: "pin" }, ({ payload }) => {
          setPinnedId(payload?.id ? String(payload.id) : null);
        })
        .on("presence", { event: "sync" }, () => {
          setFriendActive(Object.keys(ch.presenceState()).includes(fid));
        })
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
  }, [me, friendUsername, applyTimer, prune, pairFilter, signPath, markRead, decodeBody]);

  // Periodically enforce the timer while the thread is open.
  useEffect(() => {
    const id = setInterval(() => prune(), PRUNE_EVERY_MS);
    return () => clearInterval(id);
  }, [prune]);

  // Build the reply payload (absolute author id + snippet) for a target id.
  const replyMeta = useCallback((replyToId?: string | null) => {
    if (!replyToId) return null;
    const parent = msgsRef.current.find((m) => m.id === replyToId);
    if (!parent) return null;
    const authorId = parent.mine ? me : friendId.current;
    const snippet = parent.image && !parent.body ? "📷 Photo" : parent.body.slice(0, 80);
    return { authorId, snippet };
  }, [me]);

  const send = useCallback(
    async (text: string, replyToId?: string | null) => {
      const body = text.trim();
      if (!body || !me || !friendId.current) return;
      const meta = replyMeta(replyToId);
      const id = getIdentity();
      const pub = peerPub.current;
      const canEnc = !!(id && pub);
      const stored = canEnc ? encryptFor(body, pub as string, id!.sec) : body; // ciphertext when both keyed
      const { data, error } = await supabase
        .from("messages")
        .insert({ sender: me, recipient: friendId.current, body: stored, enc: canEnc, reply_to: replyToId ?? null })
        .select()
        .single();
      if (error || !data) return;
      setMessages((m) => [
        ...m,
        {
          id: String(data.id),
          mine: true,
          body: cleanText(body), // local view keeps the plaintext
          created_at: String(data.created_at),
          image: null,
          reply: meta ? { fromMe: meta.authorId === me, snippet: meta.snippet } : null,
          reactions: [],
        },
      ]);
      channel.current?.send({
        type: "broadcast",
        event: "msg",
        payload: {
          id: data.id,
          sender: me,
          body: stored,
          enc: canEnc,
          created_at: data.created_at,
          reply: replyToId ? { id: replyToId } : null,
        },
      });
      nudgeUnread();
    },
    [me, replyMeta, nudgeUnread]
  );

  const sendImage = useCallback(
    async (file: File, replyToId?: string | null): Promise<{ ok: boolean; error?: string }> => {
      if (!me || !friendId.current) return { ok: false, error: "Not ready." };
      if (!EXT[file.type]) return { ok: false, error: "Only PNG, JPG, WEBP or GIF." };
      if (file.size > MAX_IMAGE_BYTES) return { ok: false, error: "Image must be under 8 MB." };

      const [ua, ub] = [me, friendId.current].sort();
      const path = `${ua}_${ub}/${crypto.randomUUID()}.${EXT[file.type]}`;
      const up = await supabase.storage.from("dm-media").upload(path, file, { contentType: file.type });
      if (up.error) return { ok: false, error: "Upload failed. Try again." };

      const meta = replyMeta(replyToId);
      const { data, error } = await supabase
        .from("messages")
        .insert({ sender: me, recipient: friendId.current, body: "", image_path: path, reply_to: replyToId ?? null })
        .select()
        .single();
      if (error || !data) return { ok: false, error: "Couldn't send the photo." };

      const image = await signPath(path);
      setMessages((m) => [
        ...m,
        {
          id: String(data.id),
          mine: true,
          body: "",
          created_at: String(data.created_at),
          image,
          reply: meta ? { fromMe: meta.authorId === me, snippet: meta.snippet } : null,
          reactions: [],
        },
      ]);
      channel.current?.send({
        type: "broadcast",
        event: "msg",
        payload: {
          id: data.id,
          sender: me,
          body: "",
          image_path: path,
          created_at: data.created_at,
          reply: replyToId ? { id: replyToId } : null,
        },
      });
      nudgeUnread();
      return { ok: true };
    },
    [me, replyMeta, signPath, nudgeUnread]
  );

  const sendVoice = useCallback(
    async (blob: Blob, secs: number, mime: string): Promise<{ ok: boolean; error?: string }> => {
      if (!me || !friendId.current) return { ok: false, error: "Not ready." };
      const base = mime.split(";")[0];
      const ext = base.includes("mp4") ? "m4a" : base.includes("ogg") ? "ogg" : base.includes("mpeg") ? "mp3" : "webm";
      const [ua, ub] = [me, friendId.current].sort();
      const path = `${ua}_${ub}/${crypto.randomUUID()}.${ext}`;
      const up = await supabase.storage.from("dm-media").upload(path, blob, { contentType: base });
      if (up.error) return { ok: false, error: "Upload failed. Try again." };

      const dur = Math.max(1, Math.round(secs));
      const { data, error } = await supabase
        .from("messages")
        .insert({ sender: me, recipient: friendId.current, body: "", audio_path: path, audio_secs: dur })
        .select()
        .single();
      if (error || !data) return { ok: false, error: "Couldn't send the voice note." };

      const audio = await signPath(path);
      setMessages((m) => [
        ...m,
        {
          id: String(data.id),
          mine: true,
          body: "",
          created_at: String(data.created_at),
          image: null,
          audio,
          audioSecs: dur,
          reply: null,
          reactions: [],
        },
      ]);
      channel.current?.send({
        type: "broadcast",
        event: "msg",
        payload: { id: data.id, sender: me, body: "", audio_path: path, audio_secs: dur, created_at: data.created_at },
      });
      nudgeUnread();
      return { ok: true };
    },
    [me, signPath, nudgeUnread]
  );

  const react = useCallback(
    async (messageId: string, emoji: string) => {
      if (!me) return;
      const msg = msgsRef.current.find((m) => m.id === messageId);
      const current = msg?.reactions.find((r) => r.mine)?.emoji ?? null;
      const removed = current === emoji;
      setMessages((list) =>
        list.map((m) =>
          m.id === messageId ? { ...m, reactions: setReaction(m.reactions, true, removed ? null : emoji) } : m
        )
      );
      if (removed) {
        await supabase.from("message_reactions").delete().eq("message_id", messageId).eq("user_id", me);
      } else {
        await supabase
          .from("message_reactions")
          .upsert({ message_id: messageId, user_id: me, emoji }, { onConflict: "message_id,user_id" });
      }
      channel.current?.send({
        type: "broadcast",
        event: "react",
        payload: { messageId, sender: me, emoji: removed ? null : emoji },
      });
    },
    [me]
  );

  const setTyping = useCallback(
    (typing: boolean) => {
      if (!channel.current || !me) return;
      const now = Date.now();
      if (typing) {
        // Typing indicator is opt-in (privacy default: OFF). The "stop" event
        // below always sends so a previously-shown indicator can't get stuck.
        if (typeof window !== "undefined" && localStorage.getItem("ping.showTyping") !== "1") return;
        if (now - typingSent.current > 700) {
          typingSent.current = now;
          channel.current.send({ type: "broadcast", event: "typing", payload: { sender: me, typing: true } });
        }
        if (typingOff.current) clearTimeout(typingOff.current);
        typingOff.current = setTimeout(() => setTyping(false), 1500);
      } else {
        channel.current.send({ type: "broadcast", event: "typing", payload: { sender: me, typing: false } });
      }
    },
    [me]
  );

  // Either party can set the shared disappearing timer.
  const setTimer = useCallback(
    async (seconds: number) => {
      if (!me || !friendId.current) return;
      const [ua, ub] = [me, friendId.current].sort();
      applyTimer(seconds);
      await supabase.from("thread_settings").upsert({
        user_a: ua,
        user_b: ub,
        clear_after_seconds: seconds,
        updated_at: new Date().toISOString(),
      });
      channel.current?.send({ type: "broadcast", event: "timer", payload: { seconds } });
      prune();
    },
    [me, applyTimer, prune]
  );

  // Either party can pin/unpin one message for the thread. Stores only the id.
  const setPin = useCallback(
    async (messageId: string | null) => {
      if (!me || !friendId.current) return;
      const [ua, ub] = [me, friendId.current].sort();
      setPinnedId(messageId);
      await supabase.from("thread_settings").upsert({
        user_a: ua,
        user_b: ub,
        pinned_message_id: messageId,
        updated_at: new Date().toISOString(),
      });
      channel.current?.send({ type: "broadcast", event: "pin", payload: { id: messageId } });
    },
    [me]
  );

  // Scheduled messages: encrypt now (same as send), store ciphertext; a cron
  // delivers it at `scheduled_at`. Only the sender sees/cancels their own.
  const loadScheduled = useCallback(async () => {
    if (!me || !friendId.current) return;
    const { data } = await supabase
      .from("scheduled_messages")
      .select("id, body, enc, scheduled_at")
      .eq("sender", me)
      .eq("recipient", friendId.current)
      .order("scheduled_at", { ascending: true });
    const idn = getIdentity();
    const pub = peerPub.current;
    setScheduled(
      (data ?? []).map((r) => ({
        id: String(r.id),
        at: String(r.scheduled_at),
        text: r.enc && idn && pub ? decryptFrom(String(r.body), pub, idn.sec) ?? "🔒 Encrypted" : String(r.body),
      }))
    );
  }, [me]);

  const schedule = useCallback(
    async (text: string, whenISO: string, replyToId?: string | null) => {
      const body = text.trim();
      if (!body || !me || !friendId.current) return { ok: false, error: "Not ready." };
      const when = new Date(whenISO);
      if (isNaN(when.getTime()) || when.getTime() < Date.now() + 45_000)
        return { ok: false, error: "Pick a time at least a minute from now." };
      const idn = getIdentity();
      const pub = peerPub.current;
      const canEnc = !!(idn && pub);
      const stored = canEnc ? encryptFor(body, pub as string, idn!.sec) : body;
      const { error } = await supabase.from("scheduled_messages").insert({
        sender: me,
        recipient: friendId.current,
        body: stored,
        enc: canEnc,
        reply_to: replyToId ?? null,
        scheduled_at: when.toISOString(),
      });
      if (error) return { ok: false, error: "Couldn't schedule the message." };
      loadScheduled();
      return { ok: true };
    },
    [me, loadScheduled]
  );

  const cancelScheduled = useCallback(async (id: string) => {
    await supabase.from("scheduled_messages").delete().eq("id", id);
    setScheduled((s) => s.filter((x) => x.id !== id));
  }, []);

  // Delete one of your own messages for everyone (RLS lets the sender delete).
  const deleteMessage = useCallback(
    async (id: string) => {
      if (!me) return;
      await supabase.from("messages").delete().eq("id", id);
      setMessages((m) => m.filter((x) => x.id !== id));
      channel.current?.send({ type: "broadcast", event: "del", payload: { id } });
    },
    [me]
  );

  // Manual clear — wipes the whole thread for both sides.
  const clearChat = useCallback(async () => {
    if (!me || !friendId.current) return;
    await supabase.from("messages").delete().or(pairFilter());
    setMessages([]);
    channel.current?.send({ type: "broadcast", event: "cleared", payload: {} });
  }, [me, pairFilter]);

  // Block: record the block and unfriend both ways. A DB trigger then rejects
  // any future message/friend-request in either direction.
  const blockUser = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!me || !friendId.current) return { ok: false, error: "Not ready." };
    const fid = friendId.current;
    const { error } = await supabase.from("blocks").insert({ blocker: me, blocked: fid });
    if (error && error.code !== "23505") return { ok: false, error: "Couldn't block." };
    await supabase
      .from("friendships")
      .delete()
      .or(`and(requester.eq.${me},addressee.eq.${fid}),and(requester.eq.${fid},addressee.eq.${me})`);
    return { ok: true };
  }, [me]);

  // Report: write a moderation record (reporters can only insert).
  const reportUser = useCallback(
    async (reason: string): Promise<{ ok: boolean; error?: string }> => {
      if (!me || !friendId.current) return { ok: false, error: "Not ready." };
      const r = reason.trim().slice(0, 500);
      if (!r) return { ok: false, error: "Add a short reason." };
      const { error } = await supabase
        .from("reports")
        .insert({ reporter: me, reported: friendId.current, reason: r });
      if (error) return { ok: false, error: "Couldn't submit the report." };
      return { ok: true };
    },
    [me]
  );

  return {
    status,
    messages,
    friendActive,
    friendTyping,
    friendStatus,
    clearAfter,
    pinnedId,
    scheduled,
    send,
    sendImage,
    sendVoice,
    react,
    setTyping,
    setTimer,
    setPin,
    schedule,
    cancelScheduled,
    loadScheduled,
    clearChat,
    deleteMessage,
    blockUser,
    reportUser,
  };
}
