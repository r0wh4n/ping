"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { useProfile } from "@/hooks/useProfile";
import { useDM, type DMsg } from "@/hooks/useDM";
import { fmtTime } from "@/lib/time";
import Markdown from "@/components/Markdown";
import { isSaved, toggleSave } from "@/lib/saved";

const QUICK = ["❤️", "😂", "👍", "😮", "😢", "🔥"];

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, "0")}`;

// Monochrome line icons (inherit currentColor) to match the OLED theme.
const CameraIcon = ({ className = "h-5 w-5" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
);
const MicIcon = ({ className = "h-5 w-5" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);
const ClockIcon = ({ className = "h-5 w-5" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
const SendIcon = ({ className = "h-5 w-5" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4 20-7z" />
  </svg>
);
// View-once "snap" — a capture ring, distinct from the plain camera.
const SnapIcon = ({ className = "h-5 w-5" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
  </svg>
);

// Compact monochrome voice-note player. Falls back to the stored duration when
// the browser reports Infinity for MediaRecorder webm blobs (a known quirk).
function VoicePlayer({ src, secs, mine }: { src: string; secs?: number; mine: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(secs ?? 0);
  const remaining = Math.max(0, Math.round((dur || secs || 0) - cur));
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    const a = ref.current;
    if (!a) return;
    if (playing) a.pause();
    else a.play();
  };
  return (
    <div
      className={`flex items-center gap-3 rounded-2xl px-3 py-2.5 ${
        mine ? "bg-[color:var(--bubble-out-bg)] text-[color:var(--bubble-out-fg)]" : "border border-border bg-[color:var(--panel)] text-text"
      }`}
    >
      <button
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm ${
          mine ? "bg-[color:var(--bg)] text-[color:var(--text)]" : "bg-[color:var(--bubble-out-bg)] text-[color:var(--bubble-out-fg)]"
        }`}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <div className={`h-1 w-28 overflow-hidden rounded-full ${mine ? "bg-[color:var(--bubble-out-fg)]/20" : "bg-[color:var(--muted)]/25"}`}>
        <div className={`h-full rounded-full ${mine ? "bg-[color:var(--bubble-out-fg)]/70" : "bg-[color:var(--muted)]"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="mono text-xs tabular-nums opacity-80">{mmss(remaining)}</span>
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (isFinite(d) && d > 0) setDur(d);
        }}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCur(0);
        }}
      />
    </div>
  );
}

export default function DMPage() {
  const params = useParams();
  const router = useRouter();
  const handle = String(params.handle ?? "");
  const { profile, ready } = useProfile();
  const {
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
  } = useDM(profile, handle);

  const [draft, setDraft] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [activeMsg, setActiveMsg] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<DMsg | null>(null);
  const [uploading, setUploading] = useState(false);
  const [imgErr, setImgErr] = useState<string | null>(null);
  // Snap (view-once media) viewer overlay + hidden picker.
  const [snapView, setSnapView] = useState<{ url: string; kind: "image" | "video" } | null>(null);
  const snapRef = useRef<HTMLInputElement>(null);

  // safety: overflow menu, block, report
  const [menuOpen, setMenuOpen] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportNote, setReportNote] = useState<string | null>(null);

  // typing indicator is opt-in (privacy default: off)
  const [showTyping, setShowTyping] = useState(false);
  useEffect(() => {
    setShowTyping(localStorage.getItem("ping.showTyping") === "1");
  }, []);
  const toggleTyping = () => {
    const next = !showTyping;
    setShowTyping(next);
    try {
      localStorage.setItem("ping.showTyping", next ? "1" : "0");
    } catch {
      /* storage blocked */
    }
    setMenuOpen(false);
  };

  // scheduled messages
  const [schedOpen, setSchedOpen] = useState(false);
  const [schedAt, setSchedAt] = useState("");
  const [schedErr, setSchedErr] = useState<string | null>(null);
  const [schedListOpen, setSchedListOpen] = useState(false);
  const doSchedule = async () => {
    if (!draft.trim() || !schedAt) return;
    setSchedErr(null);
    const res = await schedule(draft, new Date(schedAt).toISOString());
    if (res.ok) {
      setDraft("");
      setSchedOpen(false);
      setSchedAt("");
    } else {
      setSchedErr(res.error ?? "Couldn't schedule.");
    }
  };

  const onBlock = async () => {
    if (!window.confirm(`Block @${handle}? They won't be able to message you, and you'll be unfriended.`)) return;
    const res = await blockUser();
    if (res.ok) router.replace("/app");
    else setImgErr(res.error ?? "Couldn't block.");
  };
  const submitReport = async () => {
    if (reportBusy || !reportReason.trim()) return;
    setReportBusy(true);
    setReportNote(null);
    const res = await reportUser(reportReason);
    setReportBusy(false);
    if (res.ok) {
      setReportNote("Reported. Thanks — our team will review it.");
      setReportReason("");
      setTimeout(() => setShowReport(false), 1400);
    } else {
      setReportNote(res.error ?? "Couldn't submit the report.");
    }
  };
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // voice recording
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef(0);
  const cancelledRec = useRef(false);

  const pickMime = () => {
    const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    for (const c of cands) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
    return "";
  };

  const startRec = async () => {
    setImgErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMime();
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      cancelledRec.current = false;
      mr.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recTimer.current) clearInterval(recTimer.current);
        const secs = (Date.now() - startedAt.current) / 1000;
        setRecording(false);
        setRecSecs(0);
        if (cancelledRec.current) return;
        const type = mr.mimeType || mime || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size === 0 || secs < 0.4) return;
        setUploading(true);
        const res = await sendVoice(blob, secs, type);
        if (!res.ok) setImgErr(res.error ?? "Couldn't send voice note.");
        setUploading(false);
      };
      mr.start();
      mediaRef.current = mr;
      startedAt.current = Date.now();
      setRecording(true);
      setRecSecs(0);
      recTimer.current = setInterval(() => setRecSecs((s) => s + 1), 1000);
    } catch {
      setImgErr("Microphone access denied.");
    }
  };
  const stopRec = (cancel: boolean) => {
    cancelledRec.current = cancel;
    mediaRef.current?.stop();
  };

  useEffect(() => {
    if (ready && !profile) router.replace("/app");
  }, [ready, profile, router]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, friendTyping]);

  const onSend = () => {
    if (!draft.trim()) return;
    send(draft, replyTo?.id);
    setDraft("");
    setReplyTo(null);
  };

  const onPickImage = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setImgErr(null);
    const res = await sendImage(file, replyTo?.id);
    if (!res.ok) setImgErr(res.error ?? "Couldn't send photo.");
    else setReplyTo(null);
    setUploading(false);
  };

  const onPickSnap = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setImgErr(null);
    const res = await sendSnap(file);
    if (!res.ok) setImgErr(res.error ?? "Couldn't send snap.");
    setUploading(false);
  };

  // Open a received snap in the fullscreen viewer (records the view).
  const openViewer = async (m: DMsg) => {
    const r = await openSnap(m.id);
    if (r) setSnapView(r);
  };

  // Photos auto-close after 10s (Snapchat-style); videos close when they end.
  useEffect(() => {
    if (!snapView || snapView.kind !== "image") return;
    const t = setTimeout(() => setSnapView(null), 10000);
    return () => clearTimeout(t);
  }, [snapView]);

  if (!ready || !profile) return <main className="min-h-dvh" />;

  return (
    <main className="mx-auto flex h-dvh w-full max-w-2xl flex-col overflow-hidden">
      {/* header */}
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <Link href="/app" className="text-sm text-muted transition hover:text-text">
          ← Friends
        </Link>
        <div className="flex items-center gap-2 text-sm">
          {friendActive && <span className="live-dot" />}
          <span className="mono font-medium">@{handle}</span>
          <span className="text-xs text-muted">
            {friendTyping ? "typing…" : friendActive ? "active now" : friendStatus || ""}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Link
            href={`/app/live/${handle}`}
            title="Go Live — a zero-trace conversation"
            aria-label="Go Live"
            className="px-2 text-lg leading-none text-muted transition hover:text-text"
          >
            ⚡
          </Link>
          <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="More options"
            className="px-2 text-lg leading-none text-muted transition hover:text-text"
          >
            ⋯
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-9 z-20 w-52 overflow-hidden rounded-lg border border-border bg-[color:var(--panel)] text-sm shadow-xl">
                <button
                  onClick={toggleTyping}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left transition hover:bg-[color:var(--border)]"
                >
                  <span>Typing indicator</span>
                  <span className={showTyping ? "text-text" : "text-[color:var(--faint)]"}>{showTyping ? "On" : "Off"}</span>
                </button>
                <div className="hair" />
                <Link
                  href="/app/saved"
                  onClick={() => setMenuOpen(false)}
                  className="block w-full px-4 py-2.5 text-left transition hover:bg-[color:var(--border)]"
                >
                  Saved messages
                </Link>
                <div className="hair" />
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    loadScheduled();
                    setSchedListOpen(true);
                  }}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-left transition hover:bg-[color:var(--border)]"
                >
                  <span>Scheduled</span>
                  {scheduled.length > 0 && <span className="text-[color:var(--faint)]">{scheduled.length}</span>}
                </button>
                <div className="hair" />
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    setReportNote(null);
                    setShowReport(true);
                  }}
                  className="block w-full px-4 py-2.5 text-left transition hover:bg-[color:var(--border)]"
                >
                  Report @{handle}
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onBlock();
                  }}
                  className="block w-full px-4 py-2.5 text-left text-[color:var(--danger)] transition hover:bg-red-500/10"
                >
                  Block @{handle}
                </button>
              </div>
            </>
          )}
          </div>
        </div>
      </header>

      {/* report modal */}
      {showReport && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm"
          onClick={() => setShowReport(false)}
        >
          <div className="idcard w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <p className="label">REPORT @{handle}</p>
            <p className="mt-3 text-sm text-muted">
              Tell us what&apos;s wrong. Reports are private and reviewed by our team.
            </p>
            <textarea
              autoFocus
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              maxLength={500}
              placeholder="What happened?"
              className="mono mt-4 h-28 w-full resize-none rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 py-2.5 text-sm outline-none placeholder:text-[color:var(--faint)] focus:border-[color:var(--focus)]"
            />
            {reportNote && <p className="mt-2 text-sm text-[color:var(--ok)]">{reportNote}</p>}
            <div className="mt-4 flex gap-2">
              <button
                onClick={submitReport}
                disabled={reportBusy || !reportReason.trim()}
                className="btn justify-center px-4 py-2.5 text-sm disabled:opacity-40"
              >
                {reportBusy ? "…" : "Submit report"}
              </button>
              <button onClick={() => setShowReport(false)} className="btn-ghost px-4 py-2.5 text-sm">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* scheduled messages list */}
      {schedListOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm"
          onClick={() => setSchedListOpen(false)}
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-[color:var(--panel)] p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="label">Scheduled messages</p>
              <button onClick={() => setSchedListOpen(false)} className="text-muted transition hover:text-text">✕</button>
            </div>
            {scheduled.length === 0 ? (
              <p className="mt-4 text-sm text-muted">No scheduled messages for this chat.</p>
            ) : (
              <ul className="mt-4 flex max-h-80 flex-col gap-2 overflow-y-auto">
                {scheduled.map((s) => (
                  <li key={s.id} className="rounded-lg border border-border bg-[color:var(--bg)] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="label">{new Date(s.at).toLocaleString()}</span>
                      <button
                        onClick={() => cancelScheduled(s.id)}
                        className="shrink-0 text-xs text-[color:var(--faint)] transition hover:text-[color:var(--danger)]"
                      >
                        Cancel
                      </button>
                    </div>
                    <p className="mt-1.5 break-words text-sm">{s.text}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-[color:var(--faint)]">Encrypted on your device; delivered at the set time, even if you&apos;re offline.</p>
          </div>
        </div>
      )}

      {/* disappearing-message controls */}
      {status === "ready" && (
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <label className="flex items-center gap-2 text-xs text-muted">
            <span>⏲ Disappearing</span>
            <select
              value={clearAfter}
              onChange={(e) => setTimer(Number(e.target.value))}
              className="mono rounded border border-border bg-[color:var(--panel)] px-2 py-1 text-xs text-text outline-none focus:border-[color:var(--focus)]"
            >
              <option value={0}>Off</option>
              <option value={300}>5 min</option>
              <option value={3600}>1 hour</option>
              <option value={86400}>1 day</option>
              <option value={604800}>1 week</option>
            </select>
          </label>
          <button
            onClick={() => {
              if (window.confirm("Clear this chat for both of you? This can't be undone.")) clearChat();
            }}
            className="text-xs text-muted transition hover:text-[color:var(--danger)]"
          >
            Clear chat
          </button>
        </div>
      )}

      {/* pinned banner */}
      {pinnedId && (() => {
        const pin = messages.find((x) => x.id === pinnedId);
        const label = pin
          ? pin.body || (pin.image ? "Photo" : pin.audio ? "Voice note" : "Message")
          : "Pinned message";
        return (
          <div className="flex shrink-0 items-center gap-3 border-b border-border bg-[color:var(--panel)] px-4 py-2">
            <span className="label shrink-0">📌 Pinned</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted">{label}</span>
            <button
              onClick={() => setPin(null)}
              className="shrink-0 text-xs text-[color:var(--faint)] transition hover:text-text"
              title="Unpin"
            >
              ✕
            </button>
          </div>
        );
      })()}

      {/* messages */}
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-4">
        {status === "loading" && <p className="mt-8 text-center text-sm text-muted">Loading thread…</p>}
        {status === "notfound" && (
          <div className="mt-10 text-center">
            <p className="text-muted">
              No one goes by <span className="mono text-text">@{handle}</span>.
            </p>
            <Link href="/app" className="btn mt-5 inline-flex">
              ← Back to friends
            </Link>
          </div>
        )}
        {status === "ready" && messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <p className="mono text-muted">This is the start of your thread with @{handle}.</p>
            <p className="text-sm text-[color:var(--faint)]">Say hi 👋</p>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`flex flex-col ${m.mine ? "items-end" : "items-start"}`}>
            {/* reply preview */}
            {m.reply && (
              <div className="mb-1 max-w-[78%] rounded-lg border-l-2 border-[color:var(--border-strong)] bg-[color:var(--panel)] px-2.5 py-1">
                <span className="mono text-[11px] text-muted">
                  {m.reply.fromMe ? "You" : `@${handle}`}
                </span>
                <span className="block max-w-[16rem] truncate text-xs text-[color:var(--faint)]">
                  {m.reply.snippet}
                </span>
              </div>
            )}

            {/* bubble — tap to open reaction / reply actions */}
            {m.ephemeral && !m.saved ? (
              (() => {
                const canView = !m.mine && (m.views ?? 0) < 2;
                const label = m.snapKind === "video" ? "Video" : "Photo";
                const status = m.mine
                  ? m.openedAt
                    ? "Opened"
                    : "Delivered"
                  : (m.views ?? 0) === 0
                    ? "Tap to view"
                    : (m.views ?? 0) < 2
                      ? "Tap to replay"
                      : "Opened";
                return (
                  <button
                    onClick={() => (canView ? openViewer(m) : setActiveMsg(activeMsg === m.id ? null : m.id))}
                    className={`flex max-w-[78%] items-center gap-3 rounded-2xl border px-4 py-3 text-left transition ${
                      canView
                        ? "border-[color:var(--accent)] bg-[color:var(--panel)] hover:opacity-90"
                        : "border-border bg-[color:var(--panel)] opacity-80"
                    }`}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-[color:var(--border-strong)] text-muted">
                      <SnapIcon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0">
                      <span className="mono block text-sm text-text">
                        {m.mine ? `You sent a ${label.toLowerCase()}` : `${label} snap`}
                      </span>
                      <span className="block text-xs text-[color:var(--faint)]">{status}</span>
                    </span>
                  </button>
                );
              })()
            ) : m.video ? (
              <div className="msg-in max-w-[78%]">
                <video
                  src={m.video}
                  controls
                  playsInline
                  className="max-h-72 w-auto rounded-2xl border border-border"
                />
              </div>
            ) : m.audio ? (
              <div
                onClick={() => setActiveMsg(activeMsg === m.id ? null : m.id)}
                className="msg-in max-w-[78%] cursor-pointer"
              >
                <VoicePlayer src={m.audio} secs={m.audioSecs} mine={m.mine} />
              </div>
            ) : (
              <button
                onClick={() => setActiveMsg(activeMsg === m.id ? null : m.id)}
                className={`msg-in max-w-[78%] text-left ${m.image ? "" : "block"}`}
              >
                {m.image && (
                  <span className="relative block overflow-hidden rounded-2xl">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={m.image}
                      alt="Shared photo"
                      className="max-h-72 w-auto rounded-2xl border border-border object-cover"
                    />
                    {profile && (
                      <span className="wm" aria-hidden>
                        {Array.from({ length: 16 }).map((_, i) => (
                          <span key={i}>@{profile.username}</span>
                        ))}
                      </span>
                    )}
                  </span>
                )}
                {m.body && (
                  <div
                    className={`break-words rounded-2xl px-4 py-2.5 text-[15px] leading-snug ${
                      m.image ? "mt-1 " : ""
                    }${
                      m.mine
                        ? "bg-[color:var(--bubble-out-bg)] text-[color:var(--bubble-out-fg)]"
                        : "border border-border bg-[color:var(--panel)] text-text"
                    }`}
                  >
                    <Markdown text={m.body} />
                  </div>
                )}
              </button>
            )}

            {/* reaction chips */}
            {m.reactions.length > 0 && (
              <div className={`mt-0.5 flex gap-1 ${m.mine ? "self-end" : "self-start"}`}>
                {m.reactions.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => r.mine && react(m.id, r.emoji)}
                    title={r.mine ? "Tap to remove" : undefined}
                    className={`rounded-full border px-1.5 py-0.5 text-xs ${
                      r.mine
                        ? "border-[color:var(--border-strong)] bg-[color:var(--panel-2)]"
                        : "border-border bg-[color:var(--panel)]"
                    }`}
                  >
                    {r.emoji}
                  </button>
                ))}
              </div>
            )}

            {/* timestamp — shown when the bubble is tapped */}
            {activeMsg === m.id && (
              <span className={`mono mt-1 text-[10px] text-[color:var(--faint)] ${m.mine ? "self-end" : "self-start"}`}>
                {m.mine ? "Sent" : "Received"} · {fmtTime(m.created_at)}
              </span>
            )}

            {/* action bar */}
            {activeMsg === m.id && (
              <div
                className={`mt-1 flex items-center gap-0.5 rounded-full border border-border bg-[color:var(--panel)] px-1.5 py-1 ${
                  m.mine ? "self-end" : "self-start"
                }`}
              >
                {QUICK.map((e) => (
                  <button
                    key={e}
                    onClick={() => {
                      react(m.id, e);
                      setActiveMsg(null);
                    }}
                    className="rounded-full px-1.5 py-0.5 text-base transition hover:bg-[color:var(--border)]"
                  >
                    {e}
                  </button>
                ))}
                <span className="mx-1 h-4 w-px bg-[color:var(--border-strong)]" />
                <button
                  onClick={() => {
                    setReplyTo(m);
                    setActiveMsg(null);
                  }}
                  className="px-2 text-xs text-muted transition hover:text-text"
                >
                  Reply
                </button>
                {m.ephemeral && !m.saved && (
                  <>
                    <span className="mx-1 h-4 w-px bg-[color:var(--border-strong)]" />
                    <button
                      onClick={() => {
                        saveSnap(m.id);
                        setActiveMsg(null);
                      }}
                      className="px-2 text-xs text-muted transition hover:text-text"
                    >
                      Save to chat
                    </button>
                  </>
                )}
                <span className="mx-1 h-4 w-px bg-[color:var(--border-strong)]" />
                <button
                  onClick={() => {
                    setPin(pinnedId === m.id ? null : m.id);
                    setActiveMsg(null);
                  }}
                  className="px-2 text-xs text-muted transition hover:text-text"
                >
                  {pinnedId === m.id ? "Unpin" : "Pin"}
                </button>
                {m.body && (
                  <>
                    <span className="mx-1 h-4 w-px bg-[color:var(--border-strong)]" />
                    <button
                      onClick={() => {
                        toggleSave({ id: m.id, text: m.body ?? "", from: m.mine ? "you" : `@${handle}`, handle, savedAt: Date.now() });
                        setActiveMsg(null);
                      }}
                      className="px-2 text-xs text-muted transition hover:text-text"
                    >
                      {isSaved(m.id) ? "Saved ✓" : "Save"}
                    </button>
                  </>
                )}
                {m.mine && (
                  <>
                    <span className="mx-1 h-4 w-px bg-[color:var(--border-strong)]" />
                    <button
                      onClick={() => {
                        deleteMessage(m.id);
                        setActiveMsg(null);
                      }}
                      className="px-2 text-xs text-[color:var(--danger)] transition hover:opacity-80"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}

        {(() => {
          const last = messages[messages.length - 1];
          const seen =
            last?.mine && friendSeenAt && new Date(friendSeenAt).getTime() >= new Date(last.created_at).getTime();
          return seen ? (
            <span className="mono self-end pr-1 text-[10px] text-[color:var(--faint)]">Seen</span>
          ) : null;
        })()}

        {friendTyping && (
          <div className="msg-in self-start rounded-2xl border border-border bg-[color:var(--panel)] px-4 py-3">
            <span className="typing-dots flex gap-1">
              <i /> <i /> <i />
            </span>
          </div>
        )}
      </div>

      {/* reply chip */}
      {replyTo && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs">
          <span className="min-w-0 truncate text-muted">
            Replying to {replyTo.mine ? "yourself" : `@${handle}`}:{" "}
            <span className="inline-flex items-center gap-1 text-[color:var(--faint)]">
              {replyTo.image && !replyTo.body ? (<><CameraIcon className="h-3.5 w-3.5" /> Photo</>) : replyTo.body}
            </span>
          </span>
          <button onClick={() => setReplyTo(null)} className="ml-3 shrink-0 text-muted hover:text-text">
            ✕
          </button>
        </div>
      )}
      {imgErr && <p className="border-t border-border px-4 py-2 text-xs text-[color:var(--danger)]">{imgErr}</p>}

      {/* composer */}
      {recording ? (
        <div className="pb-safe flex items-center gap-3 border-t border-border px-4 pt-3">
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span className="mono flex-1 text-sm text-[color:var(--danger)]">Recording… {mmss(recSecs)}</span>
          <button onClick={() => stopRec(true)} className="btn-ghost px-4 py-2.5 text-sm">
            Cancel
          </button>
          <button onClick={() => stopRec(false)} className="btn px-4 py-2.5 text-sm">
            Send
          </button>
        </div>
      ) : (
        <div className="pb-safe relative flex items-center gap-2 border-t border-border px-3 pt-3">
          {schedOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setSchedOpen(false)} />
              <div className="absolute bottom-full left-3 z-20 mb-2 w-72 rounded-lg border border-border bg-[color:var(--panel)] p-3 shadow-xl">
                <p className="label">Schedule this message</p>
                <input
                  type="datetime-local"
                  value={schedAt}
                  onChange={(e) => setSchedAt(e.target.value)}
                  className="mono mt-2 w-full rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 py-2 text-sm outline-none focus:border-[color:var(--focus)]"
                />
                {schedErr && <p className="mt-2 text-xs text-[color:var(--danger)]">{schedErr}</p>}
                <div className="mt-2 flex justify-end gap-2">
                  <button onClick={() => setSchedOpen(false)} className="btn-ghost px-3 py-1.5 text-xs">Cancel</button>
                  <button onClick={doSchedule} disabled={!draft.trim() || !schedAt} className="btn px-3 py-1.5 text-xs disabled:opacity-40">Schedule</button>
                </div>
                <p className="mt-2 text-[11px] text-[color:var(--faint)]">Encrypted now, delivered at the set time — even if you&apos;re offline.</p>
              </div>
            </>
          )}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            ref={fileRef}
            className="hidden"
            onChange={onPickImage}
          />
          <input
            type="file"
            accept="image/*,video/*"
            capture="environment"
            ref={snapRef}
            className="hidden"
            onChange={onPickSnap}
          />
          <button
            onClick={() => {
              setSchedErr(null);
              setSchedOpen((o) => !o);
            }}
            disabled={status !== "ready" || !draft.trim()}
            title="Schedule this message"
            aria-label="Schedule this message"
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full border border-border text-muted transition hover:border-[color:var(--accent)] hover:text-text disabled:opacity-40"
          >
            <ClockIcon />
          </button>
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setTyping(true);
            }}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onKeyDown={(e) => e.key === "Enter" && onSend()}
            disabled={status !== "ready"}
            maxLength={2000}
            placeholder={status === "ready" ? "Message @" + handle + "…" : "…"}
            className="mono min-h-[52px] min-w-0 flex-1 rounded-3xl border border-border bg-[color:var(--panel)] px-5 py-4 text-base outline-none placeholder:text-[color:var(--faint)] focus:border-[color:var(--focus)] disabled:opacity-50"
          />
          {/* Camera + voice collapse once the field is focused, leaving just
              schedule + send. Blur (tap elsewhere) brings them back. */}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={status !== "ready" || uploading}
            title="Send a photo"
            aria-label="Send a photo"
            className={`${inputFocused ? "hidden" : "grid"} h-12 w-12 shrink-0 place-items-center rounded-full border border-border text-muted transition hover:border-[color:var(--accent)] hover:text-text disabled:opacity-40`}
          >
            {uploading ? "…" : <CameraIcon />}
          </button>
          <button
            onClick={startRec}
            disabled={status !== "ready" || uploading}
            title="Record a voice note"
            aria-label="Record a voice note"
            className={`${inputFocused ? "hidden" : "grid"} h-12 w-12 shrink-0 place-items-center rounded-full border border-border text-muted transition hover:border-[color:var(--accent)] hover:text-text disabled:opacity-40`}
          >
            <MicIcon />
          </button>
          <button
            onClick={() => snapRef.current?.click()}
            disabled={status !== "ready" || uploading}
            title="Send a view-once snap (photo or video)"
            aria-label="Send a view-once snap"
            className={`${inputFocused ? "hidden" : "grid"} h-12 w-12 shrink-0 place-items-center rounded-full border border-border text-muted transition hover:border-[color:var(--accent)] hover:text-text disabled:opacity-40`}
          >
            {uploading ? "…" : <SnapIcon />}
          </button>
          <button
            onClick={onSend}
            disabled={status !== "ready" || !draft.trim()}
            title="Send"
            aria-label="Send message"
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[color:var(--accent)] text-[color:var(--on-accent)] transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendIcon />
          </button>
        </div>
      )}

      {/* Snap viewer — fullscreen, view-once. Tap or timeout to close. */}
      {snapView && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black"
          onClick={() => setSnapView(null)}
        >
          <div className="relative flex max-h-full max-w-full items-center justify-center">
            {snapView.kind === "video" ? (
              <video
                src={snapView.url}
                autoPlay
                playsInline
                onEnded={() => setSnapView(null)}
                className="max-h-[100dvh] max-w-full"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={snapView.url} alt="Snap" className="max-h-[100dvh] max-w-full object-contain" />
            )}
            <span className="wm" aria-hidden>
              {Array.from({ length: 24 }).map((_, i) => (
                <span key={i}>@{profile.username}</span>
              ))}
            </span>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSnapView(null);
            }}
            aria-label="Close"
            className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] grid h-10 w-10 place-items-center rounded-full bg-white/10 text-lg text-white backdrop-blur transition hover:bg-white/20"
          >
            ✕
          </button>
          <span className="pointer-events-none absolute bottom-6 left-0 right-0 text-center text-xs text-white/50">
            Tap anywhere to close
          </span>
        </div>
      )}
    </main>
  );
}
