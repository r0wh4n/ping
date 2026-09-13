// Ring tones, synthesised rather than shipped as audio files — a few
// oscillators cost nothing to download and cannot 404.
//
// The whole pattern is scheduled up front on the audio clock instead of driven
// by setInterval, so it stays in rhythm when the tab is throttled in the
// background — which is exactly when someone is being called.

type Burst = { freqs: number[]; at: number; dur: number };

const PATTERNS: Record<"incoming" | "outgoing", { bursts: Burst[]; period: number; volume: number }> = {
  // Two short bursts then a gap: the cadence people read as "answer me".
  incoming: {
    bursts: [
      { freqs: [660, 880], at: 0, dur: 0.38 },
      { freqs: [660, 880], at: 0.5, dur: 0.38 },
    ],
    period: 2.6,
    volume: 0.16,
  },
  // The quieter tone the caller hears while it rings at the other end.
  outgoing: {
    bursts: [{ freqs: [440, 480], at: 0, dur: 1.4 }],
    period: 4.2,
    volume: 0.07,
  },
};

function burst(ctx: BaseAudioContext, out: GainNode, b: Burst, start: number): OscillatorNode[] {
  const made: OscillatorNode[] = [];
  for (const f of b.freqs) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = f;
    osc.type = "sine";
    // Fade the edges: a square-edged gate clicks.
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(1, start + 0.02);
    gain.gain.setValueAtTime(1, start + b.dur - 0.04);
    gain.gain.linearRampToValueAtTime(0, start + b.dur);
    osc.connect(gain).connect(out);
    osc.start(start);
    osc.stop(start + b.dur + 0.02);
    made.push(osc);
  }
  return made;
}

/**
 * Lay the repeating ring pattern onto a context. Returns a stop function, and
 * is exported so the test can render it through an offline context.
 */
export function scheduleRing(ctx: BaseAudioContext, kind: keyof typeof PATTERNS, seconds: number) {
  const p = PATTERNS[kind];
  const out = ctx.createGain();
  out.gain.value = p.volume;
  out.connect(ctx.destination);
  const base = ctx.currentTime;
  const started: OscillatorNode[] = [];
  for (let cycle = 0; cycle * p.period < seconds; cycle++) {
    for (const b of p.bursts) started.push(...burst(ctx, out, b, base + cycle * p.period + b.at));
  }
  return () => {
    for (const osc of started) {
      try {
        osc.stop();
      } catch {
        /* already finished */
      }
    }
    out.disconnect();
  };
}

// One context, unlocked by the first interaction anywhere in the app. Browsers
// refuse to start audio before a gesture — and a call arrives without one, so a
// context created at ring time can come up suspended and ring silently. This is
// the difference between hearing the phone and missing it.
let shared: AudioContext | null = null;

function audioCtor() {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null;
}

/** Call from a user gesture to unlock audio for later rings. Safe to call often. */
export function primeAudio() {
  const Ctor = audioCtor();
  if (!Ctor) return;
  try {
    if (!shared) shared = new Ctor();
    if (shared.state === "suspended") void shared.resume().catch(() => {});
  } catch {
    shared = null;
  }
}

export type Ring = { stop: () => void };
const SILENT: Ring = { stop: () => {} };

/**
 * Start ringing. Autoplay rules mean this only makes sound once the person has
 * interacted with the page at all; when it is blocked the call still rings
 * visually and via the notification, so this never throws at the caller.
 */
export function playRing(kind: keyof typeof PATTERNS, seconds = 60): Ring {
  primeAudio(); // reuses the unlocked context when there is one
  const ctx = shared;
  if (!ctx) return SILENT;
  try {
    const stop = scheduleRing(ctx, kind, seconds);
    return { stop };
  } catch {
    return SILENT;
  }
}

/** Buzz the handset in the classic ring cadence until stopped. */
export function startVibrate(): () => void {
  if (typeof navigator === "undefined" || !navigator.vibrate) return () => {};
  const pulse = () => navigator.vibrate([400, 200, 400, 1600]);
  pulse();
  const t = setInterval(pulse, 2600);
  return () => {
    clearInterval(t);
    try {
      navigator.vibrate(0);
    } catch {
      /* ignore */
    }
  };
}

/**
 * An OS notification for a call arriving while the tab is in the background.
 * Returns a closer, so answering or missing it clears the banner.
 */
export function notifyIncoming(handle: string, video: boolean): () => void {
  if (typeof window === "undefined" || !("Notification" in window)) return () => {};
  if (Notification.permission !== "granted" || !document.hidden) return () => {};
  try {
    const n = new Notification(`@${handle} is calling`, {
      body: video ? "Incoming video call on Ping" : "Incoming voice call on Ping",
      tag: "ping-call",
      icon: "/icon-192.png",
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return () => n.close();
  } catch {
    return () => {};
  }
}

// Dev only: lets the ringtone test render the pattern through an offline audio
// context. Compiled out of the production bundle, same as the supabase bridge.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as { __scheduleRing?: typeof scheduleRing }).__scheduleRing = scheduleRing;
}
