"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { cleanText } from "@/lib/profanity";
import { getIdentity, encryptFor, decryptFrom } from "@/lib/crypto";
import type { Profile } from "@/hooks/useProfile";

export type Reaction = { emoji: string; mine: boolean };
export type ReplyPreview = { fromMe: boolean; snippet: string };
export type SnapKind = "image" | "video";
export type DMsg = {
  id: string;
  mine: boolean;
  body: string;
  created_at: string;
  image?: string | null; // signed URL for <img src>
  audio?: string | null; // signed URL for <audio src>
  video?: string | null; // signed URL for <video src> (saved snaps)
  audioSecs?: number;
  reply?: ReplyPreview | null;
  reactions: Reaction[];
  system?: boolean; // client-only in-thread notice (e.g. disappearing turned on)
  expireAt?: string | null; // disappearing timer: set when SEEN; null = never
  // Snapchat-style view-once media ("snaps"). The media is only signed on
  // demand (openSnap) so an unopened/consumed snap can't be re-fetched.
  ephemeral?: boolean;
  snapKind?: SnapKind;
  snapPath?: string | null; // raw storage path, signed at open time
  openedAt?: string | null; // when the recipient first opened it
  views?: number; // 0=unopened, 1=viewed (replay allowed), 2=consumed
  saved?: boolean; // saved to chat → renders inline permanently for both
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
const VIDEO_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};
const MAX_SNAP_BYTES = 50 * 1024 * 1024;
const SNAP_TTL = 120; // signed-URL lifetime when opening a snap (seconds)

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
// Human label for a disappearing-timer duration (matches the picker options).
const timerLabel = (s: number) =>
  s <= 0 ? "off"
    : s < 3600 ? `${Math.round(s / 60)} min`
      : s < 86400 ? `${Math.round(s / 3600)} hour${s >= 7200 ? "s" : ""}`
        : s < 604800 ? `${Math.round(s / 86400)} day${s >= 172800 ? "s" : ""}`
          : `${Math.round(s / 604800)} week${s >= 1209600 ? "s" : ""}`;

export function useDM(profile: Profile | null, friendUsername: string) {
  const me = profile?.id ?? null;
  const [status, setStatus] = useState<Status>("loading");
  const [messages, setMessages] = useState<DMsg[]>([]);
  const [friendActive, setFriendActive] = useState(false);
  const [friendTyping, setFriendTyping] = useState(false);
  const [friendSeenAt, setFriendSeenAt] = useState<string | null>(null); // friend's last read of my messages
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

  // Turn a raw DB/broadcast row into the media-related DMsg fields. Snaps are
  // NOT signed here (view-once) unless already saved to chat; normal photos and
  // voice notes sign up front as before.
  const buildMedia = useCallback(
    async (r: {
      image_path?: string | null;
      audio_path?: string | null;
      video_path?: string | null;
      ephemeral?: boolean;
      saved?: boolean;
      opened_at?: string | null;
      views?: number | null;
      audio_secs?: number | null;
    }): Promise<Partial<DMsg>> => {
      if (r.ephemeral) {
        const snapKind: SnapKind = r.video_path ? "video" : "image";
        const snapPath = r.video_path ?? r.image_path ?? null;
        const saved = Boolean(r.saved);
        const signed = saved && snapPath ? await signPath(snapPath) : null;
        return {
          ephemeral: true,
          snapKind,
          snapPath,
          saved,
          openedAt: r.opened_at ?? null,
          views: Number(r.views ?? 0),
          image: saved && snapKind === "image" ? signed : null,
          video: saved && snapKind === "video" ? signed : null,
          audio: null,
        };
      }
      return {
        ephemeral: false,
        image: await signPath(r.image_path),
        audio: await signPath(r.audio_path),
        video: null,
        audioSecs: r.audio_secs ? Number(r.audio_secs) : undefined,
      };
    },
    [signPath]
  );

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

  // Append a client-only system notice to the thread (not persisted).
  const pushNotice = useCallback((text: string) => {
    setMessages((m) => [
      ...m,
      { id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, mine: false, system: true, body: text, created_at: new Date().toISOString(), reactions: [] },
    ]);
  }, []);

  // Delete messages whose disappear-timer has elapsed (DB + local view). Only
  // messages with an expire_at (i.e. already SEEN) are eligible — unseen ones stay.
  const prune = useCallback(async () => {
    if (!me || !friendId.current) return;
    const nowMs = Date.now();
    await supabase
      .from("messages")
      .delete()
      .or(pairFilter())
      .not("expire_at", "is", null)
      .lt("expire_at", new Date(nowMs).toISOString());
    setMessages((m) => m.filter((msg) => !msg.expireAt || new Date(msg.expireAt).getTime() > nowMs));
  }, [me, pairFilter]);

  // Mark this thread read up to now (drives unread badges on the home list) and
  // tell the sender live so their "Seen" appears. If the thread has a disappear
  // timer, this is also where the countdown STARTS: stamp expire_at on the
  // messages I just saw (I'm their recipient) that don't have one yet.
  const markRead = useCallback(async () => {
    if (!me || !friendId.current) return;
    const now = new Date().toISOString();
    await supabase
      .from("thread_reads")
      .upsert(
        { owner: me, other: friendId.current, last_read: now },
        { onConflict: "owner,other" }
      );

    const secs = clearAfterRef.current;
    let expireAt: string | undefined;
    if (secs > 0) {
      expireAt = new Date(Date.now() + secs * 1000).toISOString();
      await supabase
        .from("messages")
        .update({ expire_at: expireAt })
        .eq("recipient", me)
        .eq("sender", friendId.current)
        .is("expire_at", null);
      setMessages((list) => list.map((m) => (!m.mine && !m.expireAt ? { ...m, expireAt } : m)));
    }
    channel.current?.send({ type: "broadcast", event: "seen", payload: { sender: me, at: now, expireAt } });
  }, [me]);

  // Append an incoming message row (from the fast Broadcast path OR the reliable
  // Postgres-changes / catch-up backstop), de-duped by id so the two delivery
  // paths never double up. This is the single source of truth for incoming rows.
  const addRow = useCallback(
    async (r: {
      id: string | number;
      sender: string;
      body?: string | null;
      enc?: boolean;
      image_path?: string | null;
      audio_path?: string | null;
      video_path?: string | null;
      audio_secs?: number | null;
      ephemeral?: boolean;
      saved?: boolean;
      opened_at?: string | null;
      views?: number | null;
      expire_at?: string | null;
      reply_to?: string | null;
      created_at: string;
      reply?: { id?: string } | null;
    }) => {
      const id = String(r.id);
      if (msgsRef.current.some((m) => m.id === id)) return;
      const mine = String(r.sender) === me;
      const media = await buildMedia(r);
      const text = cleanText(decodeBody(String(r.body ?? ""), Boolean(r.enc)));
      const replyToId = r.reply_to ?? r.reply?.id ?? null;
      const parent = replyToId ? msgsRef.current.find((x) => x.id === String(replyToId)) : undefined;
      setMessages((m) =>
        m.some((x) => x.id === id)
          ? m
          : [
              ...m,
              {
                id,
                mine,
                body: text,
                created_at: String(r.created_at),
                expireAt: r.expire_at ?? null,
                ...media,
                reply: replyFromParent(parent),
                reactions: [],
              },
            ]
      );
      if (!mine) {
        setFriendTyping(false);
        markRead();
      }
    },
    [me, buildMedia, decodeBody, markRead]
  );

  // Reliability backstop: pull anything newer than our last local message.
  // Covers messages that arrived while the realtime socket was down/reconnecting
  // (Broadcast only reaches sockets connected at send time).
  const catchUp = useCallback(async () => {
    if (!me || !friendId.current) return;
    const last = msgsRef.current[msgsRef.current.length - 1]?.created_at;
    let q = supabase
      .from("messages")
      .select("id,sender,recipient,body,enc,image_path,audio_path,video_path,audio_secs,ephemeral,saved,opened_at,views,expire_at,reply_to,created_at")
      .or(pairFilter())
      .order("created_at", { ascending: true })
      .limit(100);
    if (last) q = q.gt("created_at", last);
    const { data } = await q;
    for (const r of data ?? []) await addRow(r);
  }, [me, pairFilter, addRow]);

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

      // How far the friend has read my messages (for "Seen").
      const { data: fread } = await supabase
        .from("thread_reads")
        .select("last_read")
        .eq("owner", fid)
        .eq("other", me)
        .maybeSingle();
      if (!cancelled && fread?.last_read) setFriendSeenAt(String(fread.last_read));

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
        .select("id,sender,recipient,body,enc,image_path,audio_path,video_path,audio_secs,ephemeral,saved,opened_at,views,expire_at,reply_to,created_at")
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

      const media = await Promise.all(rows.map((r) => buildMedia(r)));
      if (cancelled) return;

      setMessages(
        rows.map((m, i) => {
          const parent = m.reply_to ? byId.get(String(m.reply_to)) : null;
          return {
            id: String(m.id),
            mine: m.sender === me,
            body: cleanText(decoded.get(String(m.id)) ?? ""),
            created_at: String(m.created_at),
            expireAt: m.expire_at ?? null,
            ...media[i],
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
      // Fast path: live broadcast. addRow de-dupes against the DB backstop below.
      ch.on("broadcast", { event: "msg" }, ({ payload }) => {
        if (payload?.sender === me) return;
        addRow(payload);
      })
        // Reliable path: every insert addressed to me from this friend, straight
        // from Postgres — arrives even if the broadcast was missed.
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "messages", filter: `recipient=eq.${me}` },
          ({ new: row }) => {
            const r = row as { sender?: string };
            if (String(r.sender) === fid) addRow(row as Parameters<typeof addRow>[0]);
          }
        )
        .on("broadcast", { event: "seen" }, ({ payload }) => {
          if (payload?.sender === me || !payload?.at) return;
          setFriendSeenAt(String(payload.at));
          // The recipient just started the disappear-timer on my messages they
          // saw; mirror the same expire_at locally so my view expires in sync.
          if (payload?.expireAt) {
            const seenMs = new Date(String(payload.at)).getTime();
            setMessages((list) =>
              list.map((m) =>
                m.mine && !m.expireAt && new Date(m.created_at).getTime() <= seenMs
                  ? { ...m, expireAt: String(payload.expireAt) }
                  : m
              )
            );
          }
        })
        // Snap lifecycle from the other side: viewed (sender sees "Opened") or
        // saved to chat (both render it inline permanently).
        .on("broadcast", { event: "snap" }, async ({ payload }) => {
          if (payload?.sender === me) return;
          const id = String(payload?.id ?? "");
          if (!id) return;
          if (payload?.saved) {
            const target = msgsRef.current.find((m) => m.id === id);
            const url = target?.snapPath ? await signPath(target.snapPath) : null;
            setMessages((list) =>
              list.map((m) =>
                m.id === id
                  ? {
                      ...m,
                      saved: true,
                      image: m.snapKind === "video" ? m.image : url,
                      video: m.snapKind === "video" ? url : m.video,
                    }
                  : m
              )
            );
          } else {
            setMessages((list) =>
              list.map((m) =>
                m.id === id
                  ? { ...m, views: payload?.views ?? m.views, openedAt: payload?.opened_at ?? m.openedAt }
                  : m
              )
            );
          }
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
          const secs = Number(payload?.seconds ?? 0);
          applyTimer(secs);
          prune();
          pushNotice(`@${friendUsername} turned disappearing messages ${secs > 0 ? `on · ${timerLabel(secs)}` : "off"}`);
        })
        .on("broadcast", { event: "pin" }, ({ payload }) => {
          setPinnedId(payload?.id ? String(payload.id) : null);
        })
        .on("presence", { event: "sync" }, () => {
          setFriendActive(Object.keys(ch.presenceState()).includes(fid));
        })
        .subscribe((s) => {
          if (s === "SUBSCRIBED") {
            ch.track({ id: me });
            markRead();
            catchUp(); // pull anything missed while (re)connecting
          }
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
  }, [me, friendUsername, applyTimer, prune, pushNotice, pairFilter, signPath, markRead, decodeBody, addRow, catchUp, buildMedia]);

  // Periodically enforce the timer while the thread is open.
  useEffect(() => {
    const id = setInterval(() => prune(), PRUNE_EVERY_MS);
    return () => clearInterval(id);
  }, [prune]);

  // Catch up whenever the tab regains focus/visibility (covers messages that
  // landed while backgrounded or offline, and re-marks the thread read).
  useEffect(() => {
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      catchUp();
      markRead();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [catchUp, markRead]);

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

  // Send a view-once "snap" (photo or short video). The media is stored like a
  // normal attachment but flagged `ephemeral`; the recipient signs it only when
  // they open it (openSnap).
  const sendSnap = useCallback(
    async (file: File): Promise<{ ok: boolean; error?: string }> => {
      if (!me || !friendId.current) return { ok: false, error: "Not ready." };
      const isVideo = file.type.startsWith("video/");
      const isImage = file.type.startsWith("image/");
      if (!isVideo && !isImage) return { ok: false, error: "Pick a photo or video." };
      if (file.size > MAX_SNAP_BYTES) return { ok: false, error: "Snap must be under 50 MB." };
      const ext = isVideo ? VIDEO_EXT[file.type] ?? "mp4" : EXT[file.type] ?? "jpg";
      const [ua, ub] = [me, friendId.current].sort();
      const path = `${ua}_${ub}/${crypto.randomUUID()}.${ext}`;
      const up = await supabase.storage.from("dm-media").upload(path, file, { contentType: file.type });
      if (up.error) return { ok: false, error: "Upload failed. Try again." };

      const col = isVideo ? { video_path: path } : { image_path: path };
      const { data, error } = await supabase
        .from("messages")
        .insert({ sender: me, recipient: friendId.current, body: "", ephemeral: true, ...col })
        .select()
        .single();
      if (error || !data) return { ok: false, error: "Couldn't send the snap." };

      setMessages((m) => [
        ...m,
        {
          id: String(data.id),
          mine: true,
          body: "",
          created_at: String(data.created_at),
          ephemeral: true,
          snapKind: isVideo ? "video" : "image",
          snapPath: path,
          saved: false,
          openedAt: null,
          views: 0,
          image: null,
          video: null,
          reply: null,
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
          ephemeral: true,
          saved: false,
          views: 0,
          opened_at: null,
          created_at: data.created_at,
          ...col,
        },
      });
      nudgeUnread();
      return { ok: true };
    },
    [me, nudgeUnread]
  );

  // Open a received snap: sign a short-lived URL and record the view. Returns
  // the URL + kind for the viewer overlay. Sender viewing their own is a no-op.
  const openSnap = useCallback(
    async (id: string): Promise<{ url: string; kind: SnapKind } | null> => {
      const msg = msgsRef.current.find((m) => m.id === id);
      if (!msg?.ephemeral || !msg.snapPath || msg.mine) return null;
      const { data } = await supabase.storage.from("dm-media").createSignedUrl(msg.snapPath, SNAP_TTL);
      const url = data?.signedUrl;
      if (!url) return null;
      const nextViews = (msg.views ?? 0) + 1;
      const openedAt = msg.openedAt ?? new Date().toISOString();
      await supabase.from("messages").update({ views: nextViews, opened_at: openedAt }).eq("id", id);
      setMessages((list) => list.map((m) => (m.id === id ? { ...m, views: nextViews, openedAt } : m)));
      channel.current?.send({
        type: "broadcast",
        event: "snap",
        payload: { id, sender: me, views: nextViews, opened_at: openedAt },
      });
      return { url, kind: msg.snapKind ?? "image" };
    },
    [me]
  );

  // Save a snap to the chat — it stops being view-once and renders inline for
  // both sides. Either party can save.
  const saveSnap = useCallback(
    async (id: string) => {
      const msg = msgsRef.current.find((m) => m.id === id);
      if (!msg?.ephemeral || msg.saved || !msg.snapPath) return;
      await supabase.from("messages").update({ saved: true }).eq("id", id);
      const url = await signPath(msg.snapPath);
      setMessages((list) =>
        list.map((m) =>
          m.id === id
            ? { ...m, saved: true, image: m.snapKind === "video" ? m.image : url, video: m.snapKind === "video" ? url : m.video }
            : m
        )
      );
      channel.current?.send({ type: "broadcast", event: "snap", payload: { id, sender: me, saved: true } });
    },
    [me, signPath]
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
        // Typing indicator is ON by default; opt out with ping.showTyping="0".
        // The "stop" event below always sends so it can't get stuck.
        if (typeof window !== "undefined" && localStorage.getItem("ping.showTyping") === "0") return;
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
      channel.current?.send({ type: "broadcast", event: "timer", payload: { seconds, by: profile?.username } });
      prune();
      pushNotice(`You turned disappearing messages ${seconds > 0 ? `on · ${timerLabel(seconds)}` : "off"}`);
    },
    [me, applyTimer, prune, pushNotice, profile]
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
    friendSeenAt,
    friendStatus,
    clearAfter,
    pinnedId,
    scheduled,
    send,
    sendImage,
    sendVoice,
    sendSnap,
    openSnap,
    saveSnap,
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
