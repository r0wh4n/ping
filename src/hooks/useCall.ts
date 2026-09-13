"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { getIdentity, encryptFor, decryptFrom } from "@/lib/crypto";
import type { Profile } from "@/hooks/useProfile";
import { keepsOutgoingCall } from "@/lib/call";
import { playRing, startVibrate, notifyIncoming } from "@/lib/ringtone";

export type CallState = "idle" | "calling" | "ringing" | "connected" | "ended";
export type CallPeer = { id: string; username: string; pub: string | null };

// Signalling rides one broadcast channel per user — the same shape the unread
// badge already uses (`unread:<uid>`), so a call rings anywhere in /app rather
// than only inside an open thread.
const chanFor = (uid: string) => `calls:${uid}`;
const RING_MS = 35_000;
const REACH_MS = 10_000; // how long to wait for the signalling channel before giving up

/**
 * Call tracing, off unless asked for: `?calldebug=1` once, or
 * localStorage.ping_call_debug = "1". Every signalling step and connection
 * state change is logged, because a call that fails silently is impossible to
 * report usefully — "connecting but not ringing" has four different causes.
 */
function debugOn(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.location.search.includes("calldebug")) {
      localStorage.setItem("ping_call_debug", "1");
      return true;
    }
    return localStorage.getItem("ping_call_debug") === "1";
  } catch {
    return false;
  }
}


// Media itself is always DTLS-SRTP encrypted by WebRTC. A TURN relay only ever
// forwards those encrypted packets, so pointing this at a third-party TURN does
// not expose call content — without one, calls fail behind symmetric NAT.
//
// NEXT_PUBLIC_TURN_URL takes a comma-separated list, because one URL is rarely
// enough: udp/3478 is fastest, and turns/443 is what gets out of networks that
// only allow what looks like HTTPS. Set all of them and the browser picks.
const turnUrls = (process.env.NEXT_PUBLIC_TURN_URL ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

const STUN: RTCIceServer = { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] };

const STATIC_TURN: RTCIceServer[] = turnUrls.length
  ? [
      {
        urls: turnUrls,
        username: process.env.NEXT_PUBLIC_TURN_USER,
        credential: process.env.NEXT_PUBLIC_TURN_CRED,
      } as RTCIceServer,
    ]
  : [];

/**
 * Ask the server to mint short-lived relay credentials, falling back to any
 * static ones in the environment and finally to STUN alone. Called per call so
 * the credentials are always fresh.
 */
async function iceServers(): Promise<RTCIceServer[]> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) {
      const res = await fetch("/turn", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const json = (await res.json()) as { iceServers?: RTCIceServer[] };
        if (json.iceServers?.length) return [STUN, ...json.iceServers];
      }
    }
  } catch {
    // Offline or the route is not deployed — STUN still covers most networks.
  }
  return [STUN, ...STATIC_TURN];
}

/**
 * 1:1 audio/video calling.
 *
 * The offer/answer/ICE payloads are sealed to the peer's box public key, so the
 * realtime server relays bytes it cannot read — same trust story as a DM. When
 * either side has no public key yet the payloads go in the clear; the media
 * stream stays end-to-end encrypted by WebRTC either way.
 */
export function useCall(profile: Profile | null) {
  const me = profile?.id ?? null;
  const myName = profile?.username ?? "";
  const [state, setState] = useState<CallState>("idle");
  const [peer, setPeer] = useState<CallPeer | null>(null);
  const [withVideo, setWithVideo] = useState(false);
  const [muted, setMuted] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const pc = useRef<RTCPeerConnection | null>(null);
  const mine = useRef<RealtimeChannel | null>(null);
  const local = useRef<MediaStream | null>(null);
  const peerRef = useRef<CallPeer | null>(null);
  const pending = useRef<RTCIceCandidateInit[]>([]); // ICE that beat the remote description
  const offer = useRef<RTCSessionDescriptionInit | null>(null); // incoming, awaiting accept
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peerCh = useRef<RealtimeChannel | null>(null); // held open for the whole call
  const peerReady = useRef(false);
  const outbox = useRef<{ event: string; payload: Record<string, unknown> }[]>([]);
  const outgoing = useRef(false); // I dialled — so I am the one who logs the call
  const connected = useRef(false);
  const stateRef = useRef<CallState>("idle");
  const reachTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasRelay = useRef(false); // a TURN server was in the ICE config for this call
  const [debug] = useState(debugOn);
  const [tracelog, setTracelog] = useState<string[]>([]);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const trace = useCallback(
    (msg: string) => {
      if (!debug) return;
      console.log("[call]", msg);
      setTracelog((l) => [...l.slice(-11), `${new Date().toISOString().slice(14, 22)} ${msg}`]);
    },
    [debug]
  );

  // ── signalling payloads are sealed to the peer when both sides have keys ──
  const seal = useCallback((obj: unknown): string => {
    const id = getIdentity();
    const pub = peerRef.current?.pub;
    const json = JSON.stringify(obj);
    return id && pub ? encryptFor(json, pub, id.sec) : json;
  }, []);

  const unseal = useCallback(<T,>(raw: string): T | null => {
    const id = getIdentity();
    const pub = peerRef.current?.pub;
    try {
      if (id && pub && raw.includes(":")) {
        const opened = decryptFrom(raw, pub, id.sec);
        if (opened) return JSON.parse(opened) as T;
      }
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }, []);

  /**
   * One channel to the peer, held open for the whole call.
   *
   * This used to open a fresh channel per message. A single offer survived that
   * — which is why a call would ring — but the moment both sides accepted they
   * each trickled a dozen ICE candidates at once, and those rapid joins to the
   * same topic collide instead of queueing. The candidates never arrived, so
   * ICE never completed and the call sat there connecting forever.
   */
  const openPeer = useCallback((peerId: string, onFail?: (why: string) => void) => {
    if (peerCh.current) return;
    const topic = chanFor(peerId);
    // A channel from a previous call may still be tearing down on this topic.
    // Joining the same topic twice collides and never subscribes, which strands
    // the offer in the outbox — the caller spins and the callee never rings.
    supabase.getChannels().forEach((c) => {
      if (c.topic === topic || c.topic === `realtime:${topic}`) supabase.removeChannel(c);
    });

    const ch = supabase.channel(topic);
    peerCh.current = ch;
    peerReady.current = false;
    trace(`opening ${topic}`);
    ch.subscribe((status, err) => {
      trace(`channel ${topic}: ${status}${err ? ` (${err})` : ""}`);
      if (status === "SUBSCRIBED") {
        peerReady.current = true;
        const queued = outbox.current;
        outbox.current = [];
        queued.forEach((m) => {
          trace(`flush ${m.event}`);
          ch.send({ type: "broadcast", ...m });
        });
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") onFail?.("Couldn't reach them.");
    });
  }, [trace]);

  /** Send to the peer, queueing anything raised before the channel is ready. */
  const signal = useCallback(
    (event: string, payload: Record<string, unknown>) => {
      if (peerCh.current && peerReady.current) {
        trace(`send ${event}`);
        peerCh.current.send({ type: "broadcast", event, payload });
      } else {
        trace(`queue ${event} (channel not ready)`);
        outbox.current.push({ event, payload });
      }
    },
    [trace]
  );

  /** One-shot send to someone who is not the current peer (turning down a second caller). */
  const signalOnce = useCallback((toUser: string, event: string, payload: Record<string, unknown>) => {
    const ch = supabase.channel(`${chanFor(toUser)}:once:${Math.random().toString(36).slice(2)}`);
    ch.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      ch.send({ type: "broadcast", event, payload });
      setTimeout(() => supabase.removeChannel(ch), 600);
    });
  }, []);

  /**
   * Leave a trace of the call in the thread. Written as a normal message so it
   * gets the DM's own encryption, unread badge and history for free — a dedicated
   * call row would need a schema change and rendering everywhere to earn it.
   * Only the caller writes, so the record never lands twice.
   */
  const logCall = useCallback(
    async (secs: number) => {
      const p = peerRef.current;
      if (!me || !p || !outgoing.current) return;
      const text = secs > 0 ? `\u{1F4DE} Call \u00b7 ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : "\u{1F4DE} Missed call";
      const identity = getIdentity();
      const canEnc = Boolean(identity && p.pub);
      await supabase.from("messages").insert({
        sender: me,
        recipient: p.id,
        body: canEnc ? encryptFor(text, p.pub!, identity!.sec) : text,
        enc: canEnc,
      });
    },
    [me]
  );

  // ── teardown ──
  const cleanup = useCallback(() => {
    if (ringTimer.current) clearTimeout(ringTimer.current);
    ringTimer.current = null;
    if (reachTimer.current) clearTimeout(reachTimer.current);
    reachTimer.current = null;
    pc.current?.close();
    pc.current = null;
    local.current?.getTracks().forEach((t) => t.stop());
    local.current = null;
    pending.current = [];
    offer.current = null;
    const ch = peerCh.current;
    peerCh.current = null;
    peerReady.current = false;
    outbox.current = [];
    // Removed on a delay so a hang-up sent a moment ago still leaves the socket.
    if (ch) setTimeout(() => supabase.removeChannel(ch), 600);
    setLocalStream(null);
    setRemoteStream(null);
    setStartedAt(null);
    startedAtRef.current = null;
    setMuted(false);
    setCamOn(false);
  }, []);

  const finish = useCallback(
    (msg?: string) => {
      const secs = startedAtRef.current ? Math.round((Date.now() - startedAtRef.current) / 1000) : 0;
      if (outgoing.current) void logCall(connected.current ? secs : 0);
      cleanup();
      outgoing.current = false;
      connected.current = false;
      setError(msg ?? null);
      setState("ended");
      peerRef.current = null;
      // Brief "ended" flash, then back to idle so the overlay can dismiss itself.
      setTimeout(() => {
        setState((s) => (s === "ended" ? "idle" : s));
        setPeer(null);
      }, msg ? 2500 : 1200);
    },
    [cleanup, logCall]
  );

  const hangup = useCallback(() => {
    const p = peerRef.current;
    if (p && me) signal("end", { from: me });
    finish();
  }, [me, signal, finish]);

  // ── peer connection ──
  const makePc = useCallback(
    (stream: MediaStream, servers: RTCIceServer[]) => {
      const conn = new RTCPeerConnection({ iceServers: servers });
      stream.getTracks().forEach((t) => conn.addTrack(t, stream));

      const remote = new MediaStream();
      setRemoteStream(remote);
      conn.ontrack = (e) => {
        e.streams[0]?.getTracks().forEach((t) => {
          if (!remote.getTracks().includes(t)) remote.addTrack(t);
        });
        setRemoteStream(new MediaStream(remote.getTracks()));
      };
      conn.onicecandidate = (e) => {
        const p = peerRef.current;
        if (e.candidate && p && me) signal("ice", { from: me, cand: seal(e.candidate.toJSON()) });
      };
      conn.onconnectionstatechange = () => {
        trace(`peer connection: ${conn.connectionState}`);
        if (conn.connectionState === "connected") {
          if (ringTimer.current) clearTimeout(ringTimer.current);
          connected.current = true;
          startedAtRef.current = startedAtRef.current ?? Date.now();
          setState("connected");
          setStartedAt(startedAtRef.current);
        }
        if (conn.connectionState === "failed")
          finish(hasRelay.current ? "Connection failed." : "Connection failed — this network needs a TURN relay.");
      };
      pc.current = conn;
      return conn;
    },
    [me, signal, seal, finish, trace]
  );

  const getMedia = useCallback(async (video: boolean) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    local.current = stream;
    setLocalStream(stream);
    setCamOn(video);
    return stream;
  }, []);

  /** Drain ICE that arrived before the remote description was set. */
  const drain = useCallback(async (conn: RTCPeerConnection) => {
    const queued = pending.current;
    pending.current = [];
    for (const c of queued) await conn.addIceCandidate(c).catch(() => {});
  }, []);

  // ── outgoing ──
  const start = useCallback(
    async (username: string, video = false) => {
      if (!me || stateRef.current !== "idle") return;
      setError(null);
      const { data } = await supabase
        .from("profiles")
        .select("id,username,public_key")
        .eq("username", username)
        .maybeSingle();
      if (!data) return finish("Couldn't find that handle.");
      const p: CallPeer = {
        id: String(data.id),
        username: String(data.username),
        pub: data.public_key ? String(data.public_key) : null,
      };
      peerRef.current = p;
      setPeer(p);
      openPeer(p.id, finish); // before any ICE can fire
      setWithVideo(video);
      setState("calling");
      try {
        const [stream, servers] = await Promise.all([getMedia(video), iceServers()]);
        hasRelay.current = servers.some((x) => String(x.urls).includes("turn"));
        trace(`ice servers: ${servers.length}, relay: ${hasRelay.current}`);
        const conn = makePc(stream, servers);
        const sdp = await conn.createOffer();
        await conn.setLocalDescription(sdp);
        signal("offer", { from: me, fromName: myName, video, sdp: seal(sdp) });
        // If the channel never subscribes the offer just sits in the outbox and
        // this side spins forever. Say so instead.
        reachTimer.current = setTimeout(() => {
          if (!peerReady.current) finish("Couldn't reach them — check your connection.");
        }, REACH_MS);
        // Set only once the offer is away: a mic/camera failure above must not
        // leave a "missed call" in their thread for a call that never rang.
        outgoing.current = true;
        ringTimer.current = setTimeout(() => finish("No answer."), RING_MS);
      } catch {
        finish("Couldn't access your mic or camera.");
      }
    },
    [me, myName, getMedia, makePc, openPeer, signal, seal, finish, trace]
  );

  // ── incoming ──
  const accept = useCallback(async () => {
    const p = peerRef.current;
    const incoming = offer.current;
    if (!me || !p || !incoming) return;
    try {
      const [stream, servers] = await Promise.all([getMedia(withVideo), iceServers()]);
      hasRelay.current = servers.some((x) => String(x.urls).includes("turn"));
      trace(`ice servers: ${servers.length}, relay: ${hasRelay.current}`);
      const conn = makePc(stream, servers);
      await conn.setRemoteDescription(incoming);
      await drain(conn);
      const answer = await conn.createAnswer();
      await conn.setLocalDescription(answer);
      signal("answer", { from: me, sdp: seal(answer) });
      offer.current = null;
    } catch {
      signal("end", { from: me });
      finish("Couldn't access your mic or camera.");
    }
  }, [me, withVideo, getMedia, makePc, drain, signal, seal, finish, trace]);

  const decline = useCallback(() => {
    const p = peerRef.current;
    if (p && me) signal("end", { from: me });
    finish();
  }, [me, signal, finish]);

  // ── my inbox: offers, answers, ICE, hangups ──
  useEffect(() => {
    if (!me) return;
    const ch = supabase.channel(chanFor(me));

    ch.on("broadcast", { event: "offer" }, async ({ payload }) => {
      const from = String(payload?.from ?? "");
      if (!from) return;
      const busy = stateRef.current !== "idle";
      // Glare: both dialled at once. Deterministic winner — the higher id gives
      // up its outgoing call and answers instead, so exactly one call survives.
      const glare = stateRef.current === "calling" && peerRef.current?.id === from;
      if (glare && keepsOutgoingCall(me, from)) return; // they stand down; keep my offer
      if (busy && !glare) {
        signalOnce(from, "end", { from: me });
        return;
      }
      if (glare) {
        cleanup();
        outgoing.current = false;
      }

      const { data } = await supabase.from("profiles").select("username,public_key").eq("id", from).maybeSingle();
      const p: CallPeer = {
        id: from,
        username: data?.username ? String(data.username) : String(payload?.fromName ?? "someone"),
        pub: data?.public_key ? String(data.public_key) : null,
      };
      peerRef.current = p;
      setPeer(p);
      openPeer(from, finish);
      const sdp = unseal<RTCSessionDescriptionInit>(String(payload?.sdp ?? ""));
      if (!sdp) return;
      offer.current = sdp;
      setWithVideo(Boolean(payload?.video));
      setState("ringing");
      ringTimer.current = setTimeout(() => finish("Missed call."), RING_MS);
    });

    ch.on("broadcast", { event: "answer" }, async ({ payload }) => {
      const conn = pc.current;
      if (!conn || String(payload?.from ?? "") !== peerRef.current?.id) return;
      const sdp = unseal<RTCSessionDescriptionInit>(String(payload?.sdp ?? ""));
      if (!sdp) return;
      await conn.setRemoteDescription(sdp).catch(() => {});
      await drain(conn);
    });

    ch.on("broadcast", { event: "ice" }, async ({ payload }) => {
      if (String(payload?.from ?? "") !== peerRef.current?.id) return;
      const cand = unseal<RTCIceCandidateInit>(String(payload?.cand ?? ""));
      if (!cand) return;
      const conn = pc.current;
      // Before the remote description lands, addIceCandidate throws — queue it.
      if (conn?.remoteDescription) await conn.addIceCandidate(cand).catch(() => {});
      else pending.current.push(cand);
    });

    ch.on("broadcast", { event: "end" }, ({ payload }) => {
      if (String(payload?.from ?? "") !== peerRef.current?.id) return;
      finish(stateRef.current === "calling" ? "Call declined." : undefined);
    });

    ch.subscribe();
    mine.current = ch;
    return () => {
      supabase.removeChannel(ch);
      mine.current = null;
    };
  }, [me, signal, signalOnce, openPeer, unseal, drain, finish, cleanup, trace]);

  /**
   * Ring, buzz and raise a notification while a call is pending — keyed on
   * state so every exit (answered, declined, missed, failed) tears all three
   * down without each of those paths having to remember to.
   */
  useEffect(() => {
    if (state !== "ringing" && state !== "calling") return;
    const incoming = state === "ringing";
    const ring = playRing(incoming ? "incoming" : "outgoing", RING_MS / 1000 + 5);
    const unbuzz = incoming ? startVibrate() : () => {};
    const unnotify = incoming ? notifyIncoming(peer?.username ?? "someone", withVideo) : () => {};
    return () => {
      ring.stop();
      unbuzz();
      unnotify();
    };
  }, [state, peer?.username, withVideo]);

  // Drop the call if the tab goes away mid-conversation.
  useEffect(() => () => cleanup(), [cleanup]);

  const toggleMute = useCallback(() => {
    const track = local.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

  const toggleCam = useCallback(() => {
    const track = local.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCamOn(track.enabled);
  }, []);

  return {
    debug,
    tracelog,
    state,
    peer,
    withVideo,
    muted,
    camOn,
    error,
    localStream,
    remoteStream,
    startedAt,
    start,
    accept,
    decline,
    hangup,
    toggleMute,
    toggleCam,
  };
}
