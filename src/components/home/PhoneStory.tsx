"use client";

import { useEffect, useRef, useState } from "react";
import { Decrypt } from "@/components/LiveRoom";
import Reveal from "@/components/site/Reveal";
import { useReducedMotion } from "@/hooks/useReducedMotion";

// How it works, told on a phone. On a wide screen the phone stays pinned while
// the five steps scroll past it, and its screen changes with each one; on a
// phone, each step carries its own small phone. A scene replays from the start
// every time its step comes back into view (its key changes, so it remounts).

const STEPS = [
  { n: "01", t: "Claim your @handle.", d: "Pick a name that's yours and set a password. No phone number, no email: your handle is how people find you." },
  { n: "02", t: "Add people by name.", d: "Send a request to their @handle. They accept, and that's your circle. No contact syncing, nothing scraped." },
  { n: "03", t: "Sealed on your phone.", d: "DMs are encrypted on your device before they leave it. The server only ever stores ciphertext; not even we can read it." },
  { n: "04", t: "Talk, don't just type.", d: "Voice notes you can scrub through, photos, snaps that disappear, voice and video calls." },
  { n: "05", t: "Go Live. Leave no trace.", d: "A conversation that exists only while you're both in it. Nothing is written to any server, and then it's gone." },
];

type SceneProps = { reduced: boolean };

function StatusBar() {
  return (
    <div className="ps-status">
      <span>9:41</span>
      <span className="flex items-center gap-1">
        <svg viewBox="0 0 18 12" className="h-2.5 w-3.5" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1" /><rect x="5" y="5" width="3" height="7" rx="1" /><rect x="10" y="2" width="3" height="10" rx="1" /><rect x="15" y="0" width="3" height="12" rx="1" opacity="0.4" /></svg>
        <svg viewBox="0 0 26 12" className="h-2.5 w-5" fill="none" stroke="currentColor"><rect x="0.5" y="0.5" width="22" height="11" rx="3" opacity="0.5" /><rect x="2.5" y="2.5" width="15" height="7" rx="1.5" fill="currentColor" stroke="none" /><path d="M24.5 4v4" opacity="0.5" /></svg>
      </span>
    </div>
  );
}

function Avatar({ l, live }: { l: string; live?: boolean }) {
  return (
    <span className="ps-avatar">
      {l.toUpperCase()}
      {live && <span className="ps-avatar-dot" />}
    </span>
  );
}

function ChatTop({ handle, status }: { handle: string; status: string }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-[color:var(--border)] px-3.5 pb-2.5 pt-1">
      <span className="text-[13px] text-[color:var(--faint)]">‹</span>
      <Avatar l={handle[0]} live />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold leading-tight">@{handle}</span>
        <span className="block text-[10px] leading-tight text-[color:var(--muted)]">{status}</span>
      </span>
    </div>
  );
}

function Bubble({ mine, children, delay }: { mine?: boolean; children: React.ReactNode; delay?: number }) {
  return (
    <div className={`${mine ? "self-end" : "self-start"} ${delay !== undefined ? "ps-pop" : ""}`} style={delay !== undefined ? { animationDelay: `${delay}s` } : undefined}>
      <span className={`ps-bubble ${mine ? "ps-mine" : ""}`}>{children}</span>
    </div>
  );
}

function Composer() {
  return (
    <div className="flex items-center gap-2 border-t border-[color:var(--border)] px-3 pb-5 pt-2.5">
      <span className="ps-icon">+</span>
      <span className="flex-1 rounded-full border border-[color:var(--border)] px-3 py-1.5 text-[11px] text-[color:var(--faint)]">Message @rohan…</span>
      <span className="ps-icon">●</span>
    </div>
  );
}

// The person's own input: the one thing on a phone that types letter by letter.
function Typed({ text, reduced, delay = 0 }: { text: string; reduced: boolean; delay?: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (reduced) return;
    let k = 0;
    let id: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      id = setInterval(() => {
        k += 1;
        setN(k);
        if (k >= text.length) clearInterval(id);
      }, 120);
    }, delay);
    return () => {
      clearTimeout(start);
      clearInterval(id);
    };
  }, [text, reduced, delay]);
  const shown = reduced ? text.length : n;
  return (
    <>
      {text.slice(0, shown)}
      {shown < text.length && <span className="claim-caret" />}
    </>
  );
}

function ClaimScene({ reduced }: SceneProps) {
  return (
    <>
      <StatusBar />
      <div className="flex flex-1 flex-col justify-center px-6 pb-12">
        <p className="label text-[9.5px]">Create your account</p>
        <p className="mt-3 text-[23px] font-semibold leading-[1.1] tracking-tight">
          Claim your
          <br />
          <span className="gradient-text">@username</span>
        </p>
        <div className="ps-field mt-6">
          <span className="text-[color:var(--faint)]">@</span>
          <Typed text="maya" reduced={reduced} delay={500} />
        </div>
        <div className="ps-field mt-2 tracking-[0.2em] text-[color:var(--faint)]">••••••••</div>
        <p className="ps-pop mt-3 text-[11px] text-[color:var(--muted)]" style={{ animationDelay: "1.3s" }}>
          ✓ @maya is yours
        </p>
        <div className="ps-pop ps-cta mt-5" style={{ animationDelay: "1.5s" }}>
          Claim @maya →
        </div>
      </div>
    </>
  );
}

const FRIENDS = [
  { h: "rohan", s: "active now", live: true },
  { h: "zara", s: "typing…", live: true },
  { h: "neo", s: "seen 2m ago" },
];

function AddScene() {
  return (
    <>
      <StatusBar />
      <p className="px-5 pt-1 text-[19px] font-semibold tracking-tight">Friends</p>
      <div className="ps-request mx-4 mt-4">
        <div className="flex items-center gap-2.5">
          <Avatar l="r" />
          <p className="text-[12px] leading-snug">
            <span className="font-semibold">@rohan</span> wants to add you
          </p>
        </div>
        <div className="mt-3 flex gap-2">
          <span className="ps-accept">Accept</span>
          <span className="ps-ignore">Ignore</span>
        </div>
      </div>
      <div className="ps-toast mx-4">✓ You and @rohan are friends</div>
      <div className="mt-3 flex flex-col">
        {FRIENDS.map((f, i) => (
          <div key={f.h} className="ps-row" style={{ "--i": i } as React.CSSProperties}>
            <Avatar l={f.h[0]} live={f.live} />
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-medium">@{f.h}</span>
              <span className="block text-[10.5px] text-[color:var(--muted)]">{f.s}</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function SealedScene({ reduced }: SceneProps) {
  return (
    <>
      <StatusBar />
      <ChatTop handle="rohan" status="active now" />
      <div className="flex flex-1 flex-col justify-end gap-1.5 px-3 pb-3">
        <Bubble>movie tonight?</Bubble>
        <Bubble mine>yes. 9pm?</Bubble>
        <Bubble delay={0.5}>
          <Decrypt text="done. sending the link" reduced={reduced} delay={900} />
        </Bubble>
        <p className="ps-pop mt-2 text-center text-[9.5px] text-[color:var(--faint)]" style={{ animationDelay: "2.2s" }}>
          sealed on @rohan&apos;s phone · opened on yours
        </p>
      </div>
      <Composer />
    </>
  );
}

const WAVE = [6, 10, 16, 9, 20, 14, 24, 12, 18, 8, 22, 16, 10, 26, 14, 20, 9, 15, 22, 11, 17, 7, 13, 19, 10, 6];

function VoiceScene() {
  return (
    <>
      <StatusBar />
      <ChatTop handle="rohan" status="active now" />
      <div className="flex flex-1 flex-col justify-end gap-1.5 px-3 pb-3">
        <Bubble>call me when you&apos;re free</Bubble>
        <div className="ps-pop self-end" style={{ animationDelay: "0.3s" }}>
          <span className="ps-voice">
            <span className="ps-play">▶</span>
            <span className="ps-wave">
              {WAVE.map((h, i) => (
                <i key={i} style={{ height: h, "--i": i } as React.CSSProperties} />
              ))}
            </span>
            <span className="mono text-[9.5px]">0:07</span>
          </span>
        </div>
        <Bubble delay={1}>on my way</Bubble>
      </div>
      <div className="ps-call">
        <span className="ps-call-ring">R</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-semibold">@rohan</span>
          <span className="block text-[10px] text-[color:var(--muted)]">voice call · ringing…</span>
        </span>
        <span className="ps-call-btn">✕</span>
        <span className="ps-call-btn ps-answer">✓</span>
      </div>
    </>
  );
}

const LIVE = ["you there?", "yeah. just us", "say it, then it's gone", "nothing saved. anywhere."];

function LiveScene() {
  return (
    <>
      <StatusBar />
      <div className="flex items-center justify-between border-b border-[color:var(--border)] px-4 pb-2.5 pt-1">
        <span className="text-[12.5px] font-semibold"><span className="mono-emoji">⚡</span> Live · @rohan</span>
        <span className="flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.14em] text-[color:var(--muted)]">
          <span className="live-dot" /> live
        </span>
      </div>
      <p className="border-b border-[color:var(--border)] px-4 py-2 text-center text-[10px] text-[color:var(--muted)]">Nothing here is saved. Not on any server.</p>
      <div className="flex flex-1 flex-col justify-end gap-1.5 px-3 pb-5">
        {LIVE.map((m, i) => (
          <div key={m} className={`ps-burn ${i % 2 ? "self-end" : "self-start"}`} style={{ "--i": i } as React.CSSProperties}>
            <span className={`ps-bubble ${i % 2 ? "ps-mine" : ""}`}>{m}</span>
          </div>
        ))}
      </div>
    </>
  );
}

const SCENES: ((p: SceneProps) => React.ReactElement)[] = [ClaimScene, AddScene, SealedScene, VoiceScene, LiveScene];

function Phone({ show, active, epochs, reduced, className = "" }: { show: number[]; active: number; epochs: number[]; reduced: boolean; className?: string }) {
  return (
    <div className={`phone ${className}`} aria-hidden="true">
      <div className="phone-screen">
        <div className="phone-island" />
        {show.map((i) => {
          const Scene = SCENES[i];
          return (
            <div key={`${i}:${epochs[i]}`} className="ps-scene" data-active={i === active ? "" : undefined}>
              <Scene reduced={reduced} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function PhoneStory() {
  const reduced = useReducedMotion();
  const steps = useRef<(HTMLDivElement | null)[]>([]);
  const [view, setView] = useState({ active: 0, epochs: [0, 0, 0, 0, 0] });

  // A step is current while it crosses the middle of the screen.
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = Number((e.target as HTMLElement).dataset.step);
          setView((v) => (v.active === i ? v : { active: i, epochs: v.epochs.map((n, k) => (k === i ? n + 1 : n)) }));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" }
    );
    steps.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <section id="how" className="scroll-mt-24 pt-20 sm:pt-28">
      <div className="wrap">
        <div className="max-w-2xl">
          <p className="label">HOW IT WORKS</p>
          <Reveal text="From @handle to hello in a minute." accent={[1]} className="display mt-4 text-4xl sm:text-6xl" />
        </div>
        <div className="grid gap-x-20 lg:grid-cols-[1fr_340px]">
          <div>
            {STEPS.map((s, i) => (
              <div
                key={s.n}
                ref={(el) => {
                  steps.current[i] = el;
                }}
                data-step={i}
                className="flex flex-col justify-center border-b border-border py-14 last:border-0 lg:min-h-[85vh] lg:border-0 lg:py-0"
              >
                <span className="mono text-[13px] text-[color:var(--faint)]">{s.n}</span>
                <h3 className={`mt-3 text-3xl font-semibold tracking-tight transition-colors duration-500 sm:text-[42px] sm:leading-[1.08] ${view.active === i ? "text-text" : "text-text lg:text-[color:var(--faint)]"}`}>{s.t}</h3>
                <p className={`mt-4 max-w-md text-[17px] leading-relaxed transition-colors duration-500 ${view.active === i ? "text-muted" : "text-muted lg:text-[color:var(--faint)]"}`}>{s.d}</p>
                <div className="mt-10 flex justify-center lg:hidden">
                  <Phone show={[i]} active={i} epochs={view.epochs} reduced={reduced} className="phone-sm" />
                </div>
              </div>
            ))}
          </div>
          <div className="hidden lg:block">
            <div className="sticky top-[calc(50vh-310px)] py-4">
              <Phone show={[0, 1, 2, 3, 4]} active={view.active} epochs={view.epochs} reduced={reduced} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
