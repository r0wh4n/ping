"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { cleanText } from "@/lib/profanity";
import { newKeyPair, toB64, sharedKey, sealLive, openLive } from "@/lib/crypto";
import type { Profile } from "@/hooks/useProfile";

export type LiveMsg = { id: string; mine: boolean; body: string };
type Status = "waiting" | "live" | "left" | "notfound";

/**
 * A zero-trace "Live" conversation: exists only while both people are present.
 * Messages ride a fresh ephemeral-key channel and are held ONLY in memory —
 * never written to the DB, localStorage, or a backup. When either side leaves,
 * the session key + all messages are shredded. Nothing to recover, anywhere.
 */
export function useLive(profile: Profile | null, friendUsername: string) {
  const me = profile?.id ?? null;
  const [status, setStatus] = useState<Status>("waiting");
  const [messages, setMessages] = useState<LiveMsg[]>([]);
  const [hidden, setHidden] = useState(false); // blur/tab-away → blank the moment

  const eph = useRef(newKeyPair()); // ephemeral identity for THIS session only
  const shared = useRef<Uint8Array | null>(null);
  const channel = useRef<RealtimeChannel | null>(null);
  const friendId = useRef<string | null>(null);
  const seq = useRef(0);

  const shred = useCallback(() => {
    shared.current = null;
    setMessages([]);
  }, []);

  useEffect(() => {
    if (!me || !friendUsername) return;
    let cancelled = false;

    (async () => {
      const { data: fr } = await supabase
        .from("profiles")
        .select("id,username")
        .eq("username", friendUsername.toLowerCase())
        .maybeSingle();
      if (cancelled) return;
      if (!fr) {
        setStatus("notfound");
        return;
      }
      const fid = String(fr.id);
      friendId.current = fid;
      const [ua, ub] = [me, fid].sort();
      const myEphPub = toB64(eph.current.pub);

      const ch = supabase.channel(`live:${ua}:${ub}`, { config: { presence: { key: me } } });

      const deriveWith = (peerEphPub: string) => {
        if (!shared.current) shared.current = sharedKey(peerEphPub, eph.current.sec);
        setStatus("live");
      };

      ch.on("broadcast", { event: "hello" }, ({ payload }) => {
        if (payload?.from === me || !payload?.eph) return;
        deriveWith(String(payload.eph));
        // Reply so a peer who joined first also gets our ephemeral key.
        ch.send({ type: "broadcast", event: "hello", payload: { from: me, eph: myEphPub } });
      })
        .on("broadcast", { event: "live-msg" }, ({ payload }) => {
          if (payload?.from === me || !shared.current) return;
          const text = openLive(String(payload.box ?? ""), shared.current);
          if (text === null) return;
          setMessages((m) => [...m, { id: `r${seq.current++}`, mine: false, body: cleanText(text) }]);
        })
        .on("broadcast", { event: "bye" }, ({ payload }) => {
          if (payload?.from === me) return;
          shred();
          setStatus("left");
        })
        .on("presence", { event: "leave" }, ({ key }) => {
          if (key === fid) {
            shred();
            setStatus("left");
          }
        })
        .subscribe((s) => {
          if (s === "SUBSCRIBED") {
            ch.track({ id: me });
            ch.send({ type: "broadcast", event: "hello", payload: { from: me, eph: myEphPub } });
          }
        });
      channel.current = ch;
    })();

    return () => {
      cancelled = true;
      channel.current?.send({ type: "broadcast", event: "bye", payload: { from: me } });
      if (channel.current) supabase.removeChannel(channel.current);
      channel.current = null;
      shred();
    };
  }, [me, friendUsername, shred]);

  // Blank the moment when the tab loses focus / goes to background.
  useEffect(() => {
    const onVis = () => setHidden(document.visibilityState !== "visible");
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", () => setHidden(true));
    window.addEventListener("focus", () => setHidden(false));
    return () => {
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const send = useCallback(
    (text: string) => {
      const body = text.trim();
      if (!body || !shared.current || !channel.current) return;
      channel.current.send({
        type: "broadcast",
        event: "live-msg",
        payload: { from: me, box: sealLive(body, shared.current) },
      });
      setMessages((m) => [...m, { id: `m${seq.current++}`, mine: true, body: cleanText(body) }]);
    },
    [me]
  );

  return { status, messages, hidden, send };
}
