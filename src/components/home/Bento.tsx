"use client";

import { useRef } from "react";
import Reveal from "@/components/site/Reveal";

// What's in it, as a bento of cards that each show the feature working. Light
// follows the pointer along the card edges. Every visual is CSS, loops quietly,
// and holds still under reduced motion.

function Card({ title, body, className = "", children }: { title: string; body: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`spot-card reveal flex flex-col ${className}`}>
      <div className="relative flex min-h-[170px] flex-1 items-center justify-center overflow-hidden p-6" aria-hidden="true">
        {children}
      </div>
      <div className="relative border-t border-border px-6 py-5">
        <h3 className="text-[16px] font-semibold tracking-tight">{title}</h3>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{body}</p>
      </div>
    </div>
  );
}

function Calls() {
  return (
    <div className="flex flex-col items-center">
      <div className="radar">
        <span className="radar-ring" />
        <span className="radar-ring" />
        <span className="radar-ring" />
        <span className="radar-core grid place-items-center text-[22px] font-semibold text-black">M</span>
      </div>
      <p className="mt-2 text-[15px] font-semibold">@maya</p>
      <p className="text-[12px] text-muted">video call · ringing…</p>
      <div className="mt-5 flex gap-10">
        <span className="grid h-11 w-11 place-items-center rounded-full border border-[color:var(--border-strong)] text-muted">✕</span>
        <span className="grid h-11 w-11 place-items-center rounded-full bg-white text-black">✓</span>
      </div>
    </div>
  );
}

function Snap() {
  return (
    <div className="snap-tile">
      <span className="snap-photo" />
      <span className="snap-veil">
        <span className="text-[12px] font-medium">Tap to view</span>
        <span className="text-[10px] text-muted">1 replay, then gone</span>
      </span>
    </div>
  );
}

function Schedule() {
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 64 64" className="h-16 w-16 shrink-0 text-[color:var(--muted)]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="32" cy="32" r="29" />
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => (
          <path key={i} d="M32 6v4" transform={`rotate(${i * 30} 32 32)`} opacity={i % 3 ? 0.4 : 1} />
        ))}
        <path d="M32 32V17" className="clock-hour" stroke="#fff" strokeWidth="2" />
        <path d="M32 32V11" className="clock-min" stroke="#fff" />
      </svg>
      <div className="flex flex-col items-start gap-1.5">
        <span className="ps-bubble ps-mine text-[12.5px]">happy birthday!!</span>
        <span className="mono rounded-full border border-border px-2 py-0.5 text-[10px] text-muted">sends at 00:00</span>
      </div>
    </div>
  );
}

function Reactions() {
  return (
    <div className="flex flex-col items-start">
      <span className="ps-bubble text-[13px]">we got the flat!!</span>
      <div className="-mt-1 ml-3 flex gap-1">
        {["❤️", "😂", "🔥"].map((e, i) => (
          <span key={e} className="react-pop mono-emoji" style={{ "--i": i } as React.CSSProperties}>
            {e}
          </span>
        ))}
      </div>
      <span className="mt-3 self-end rounded-lg border-l-2 border-[color:var(--border-strong)] bg-[color:var(--panel-2)] px-2.5 py-1 text-[11px] text-muted">↩ replying to “we got the flat!!”</span>
    </div>
  );
}

function Poll() {
  const opts: [string, number][] = [["pizza", 62], ["tacos", 38]];
  return (
    <div className="w-full max-w-[220px]">
      <p className="text-[13px] font-medium">friday dinner?</p>
      <div className="mt-3 flex flex-col gap-2">
        {opts.map(([o, pct], i) => (
          <div key={o} className="relative overflow-hidden rounded-lg border border-border px-3 py-1.5 text-[12px]">
            <span className="poll-fill" style={{ "--w": `${pct}%`, "--i": i } as React.CSSProperties} />
            <span className="relative flex justify-between">
              <span>{o}</span>
              <span className="mono text-muted">{pct}%</span>
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10.5px] text-[color:var(--faint)]">8 votes · group poll</p>
    </div>
  );
}

function Disappear() {
  return (
    <div className="flex w-full max-w-[220px] flex-col gap-1.5">
      <span className="mono self-center rounded-full border border-border px-2 py-0.5 text-[10px] text-muted">⏲ messages clear after 24h</span>
      {["the door code is 4471", "got it, deleting", "👍"].map((m, i) => (
        <span key={m} className={`fade-msg ${i === 1 ? "self-end" : "self-start"}`} style={{ "--i": i } as React.CSSProperties}>
          <span className={`ps-bubble text-[12px] ${i === 1 ? "ps-mine" : ""} ${i === 2 ? "mono-emoji" : ""}`}>{m}</span>
        </span>
      ))}
    </div>
  );
}

function Presence() {
  return (
    <div className="flex w-full max-w-[220px] flex-col gap-3">
      {[
        ["maya", "active now", "live"],
        ["rohan", "typing", "typing"],
        ["zara", "seen 5m ago", ""],
      ].map(([h, s, k]) => (
        <div key={h} className="flex items-center gap-3">
          <span className="ps-avatar">
            {h[0].toUpperCase()}
            {k === "live" && <span className="ps-avatar-dot" />}
          </span>
          <span className="flex-1 text-[13px]">@{h}</span>
          {k === "typing" ? (
            <span className="typing-dots flex gap-1">
              <i /> <i /> <i />
            </span>
          ) : (
            <span className="text-[11px] text-muted">{s}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function NoNumber() {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="no-number mono text-[17px] text-muted">+91 98•• ••• •••</span>
      <span className="handle-in mono text-[22px] font-semibold">@you</span>
    </div>
  );
}

function Block() {
  return (
    <div className="flex flex-col items-center gap-3">
      <svg viewBox="0 0 48 48" className="h-12 w-12 text-white" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="24" cy="24" r="18" />
        <path d="M11.5 11.5l25 25" />
      </svg>
      <span className="mono rounded-full border border-border px-2.5 py-1 text-[11px] text-muted">@spam_bot blocked · both ways</span>
    </div>
  );
}

export default function Bento() {
  const grid = useRef<HTMLDivElement>(null);
  // Hand each card the pointer's position in its own coordinates.
  const move = (e: React.PointerEvent) => {
    grid.current?.querySelectorAll<HTMLElement>(".spot-card").forEach((c) => {
      const r = c.getBoundingClientRect();
      c.style.setProperty("--mx", `${e.clientX - r.left}px`);
      c.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  };
  return (
    <section id="features" className="scroll-mt-24 border-t border-border py-20 sm:py-28">
      <div className="wrap">
        <div className="max-w-2xl">
          <p className="label">WHAT&apos;S IN IT</p>
          <Reveal text="Everything a chat needs. Nothing it doesn't." accent={[3]} className="display mt-4 text-4xl sm:text-6xl" />
        </div>
        <div ref={grid} onPointerMove={move} className="spot-grid mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="sm:col-span-2 lg:row-span-2" title="Voice and video calls" body="Ring anyone in your circle straight from the thread.">
            <Calls />
          </Card>
          <Card title="Snaps that disappear" body="Photos and videos that disappear from the chat once they're viewed.">
            <Snap />
          </Card>
          <Card title="Schedule a message" body="Encrypted now, delivered at the set time, even if you're offline.">
            <Schedule />
          </Card>
          <Card title="Reactions, replies, pins" body="Answer the exact message, react, pin what matters.">
            <Reactions />
          </Card>
          <Card title="Groups and polls" body="Bring a few people into one thread and settle it with a vote.">
            <Poll />
          </Card>
          <Card title="Disappearing chats" body="Per-thread timers clear the history for both sides. Or unsend anything.">
            <Disappear />
          </Card>
          <Card title="Presence and typing" body="See who's around and who's typing, or switch your own indicator off.">
            <Presence />
          </Card>
          <Card title="No phone number" body="Your @handle is all anyone needs. There's nothing to scrape.">
            <NoNumber />
          </Card>
          <Card title="Block and report" body="One tap blocks both ways. No feed, no ads, no algorithm.">
            <Block />
          </Card>
        </div>
      </div>
    </section>
  );
}
