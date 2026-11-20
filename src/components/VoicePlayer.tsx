"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, "0")}`;

const SKIP_SECS = 10; // the −10 / +10 buttons
const NUDGE_SECS = 5; // arrow keys while the bar has focus

// Can the browser move to an arbitrary time in this element? A server that
// ignores Range requests leaves `seekable` empty, and then every seek is a
// silent no-op — which is what "can't go forward or back" looked like.
const canSeek = (a: HTMLAudioElement) => a.seekable.length > 0 && isFinite(a.duration);

// Compact monochrome voice-note player: play/pause, seek (drag or tap the bar,
// −10 / +10, arrow keys), and playback speed. Falls back to the stored duration
// when the browser reports Infinity for MediaRecorder webm blobs (a known quirk).
//
// Every control stops propagation. The bubble holding this player opens its
// message menu on click, and using a control must not open it.
export default function VoicePlayer({ src, secs, mine }: { src: string; secs?: number; mine: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const whole = useRef<Promise<string | null> | null>(null);
  const blobUrl = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(secs ?? 0);
  const [rate, setRate] = useState(1);
  // A codec the browser can't decode fires `play` and then errors, which looked
  // exactly like playing silently. Say so instead.
  const [dead, setDead] = useState(false);

  useEffect(() => () => {
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
  }, []);

  const remaining = Math.max(0, Math.round((dur || secs || 0) - cur));
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;

  // Download the whole note once and play it from memory. Only needed when the
  // network copy cannot be sought (see canSeek).
  const loadWhole = () => {
    if (!whole.current) {
      whole.current = fetch(src)
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => {
          if (!b) return null;
          blobUrl.current = URL.createObjectURL(b);
          return blobUrl.current;
        })
        .catch(() => null);
    }
    return whole.current;
  };

  const seekTo = async (t: number) => {
    const a = ref.current;
    if (!a || !dur) return;
    const target = Math.min(Math.max(t, 0), dur);
    setCur(target);
    if (canSeek(a)) {
      a.currentTime = target;
      return;
    }
    const u = await loadWhole();
    const el = ref.current;
    if (!u || !el) return;
    if (el.src !== u) {
      const wasPlaying = !el.paused;
      el.src = u;
      await new Promise<void>((done) => el.addEventListener("loadedmetadata", () => done(), { once: true }));
      if (wasPlaying) void el.play().catch(() => setDead(true));
    }
    el.currentTime = target;
  };

  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    const a = ref.current;
    if (!a) return;
    if (playing) a.pause();
    else a.play().catch(() => setDead(true));
  };

  const cycleRate = (e: MouseEvent) => {
    e.stopPropagation();
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (ref.current) ref.current.playbackRate = next;
  };

  const skip = (e: MouseEvent, by: number) => {
    e.stopPropagation();
    void seekTo((ref.current?.currentTime ?? cur) + by);
  };

  // The bar is the only place a pointer can seek, so it behaves the same with a
  // mouse, a finger or a pen. The pointer is captured so a drag that leaves the
  // bar keeps seeking.
  const fracAt = (clientX: number) => {
    const r = barRef.current?.getBoundingClientRect();
    return r && r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
  };
  const onBarDown = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    void seekTo(fracAt(e.clientX) * dur);
  };
  const onBarMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    e.stopPropagation();
    void seekTo(fracAt(e.clientX) * dur);
  };
  const onBarUp = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    dragging.current = false;
  };
  const onBarKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? NUDGE_SECS : e.key === "ArrowLeft" ? -NUDGE_SECS : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    void seekTo((ref.current?.currentTime ?? cur) + step);
  };

  return (
    <div
      className={`flex items-center gap-2 rounded-2xl px-3 py-2.5 ${
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
      <button
        onClick={(e) => skip(e, -SKIP_SECS)}
        aria-label={`Back ${SKIP_SECS} seconds`}
        className="mono shrink-0 px-0.5 text-[11px] tabular-nums opacity-70"
      >
        −{SKIP_SECS}
      </button>
      <div
        ref={barRef}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(cur)}
        aria-valuetext={`${mmss(cur)} of ${mmss(dur)}`}
        onPointerDown={onBarDown}
        onPointerMove={onBarMove}
        onPointerUp={onBarUp}
        onPointerCancel={onBarUp}
        onKeyDown={onBarKey}
        onClick={(e) => e.stopPropagation()}
        // The bar is 4rem wide and shrinks, never below 2rem, when the bubble is
        // squeezed. The width is what sizes the bubble; an unsized flex item would
        // collapse to its minimum and leave the bar too small to grab.
        className="relative h-6 w-16 min-w-[2rem] cursor-pointer touch-none select-none"
      >
        <div
          className={`absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full ${
            mine ? "bg-[color:var(--bubble-out-fg)]/20" : "bg-[color:var(--muted)]/25"
          }`}
        >
          <div
            className={`h-full rounded-full ${mine ? "bg-[color:var(--bubble-out-fg)]/70" : "bg-[color:var(--muted)]"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <button
        onClick={(e) => skip(e, SKIP_SECS)}
        aria-label={`Forward ${SKIP_SECS} seconds`}
        className="mono shrink-0 px-0.5 text-[11px] tabular-nums opacity-70"
      >
        +{SKIP_SECS}
      </button>
      <span className="mono text-xs tabular-nums opacity-80">{dead ? "can't play" : mmss(remaining)}</span>
      {/* Tap to cycle 1× → 1.5× → 2×. Per note, not remembered across them. */}
      <button onClick={cycleRate} aria-label={`Playback speed ${rate}×`} className="mono shrink-0 rounded-full px-1 text-[11px] tabular-nums opacity-70">
        {rate}×
      </button>
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (isFinite(d) && d > 0) setDur(d);
          e.currentTarget.playbackRate = rate;
        }}
        onError={() => {
          setPlaying(false);
          setDead(true);
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
