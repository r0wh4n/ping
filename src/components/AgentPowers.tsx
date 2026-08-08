"use client";

import TiltCard from "@/components/TiltCard";
import { Terminal, AnimatedSpan, TypingAnimation } from "@/components/Terminal";

// Shows what Ping does with plain, everyday examples (a website-redesign
// project) rather than describing it. OLED / monospace idiom to match the site.

function PanelBar({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
      <span className="mono text-[11px] tracking-wide text-muted">{title}</span>
      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-[color:var(--faint)]">
        <span className="live-dot" /> ai
      </span>
    </div>
  );
}

function Copy({ n, kicker, title, body }: { n: string; kicker: string; title: string; body: string }) {
  return (
    <div className="rise">
      <p className="label">
        {n} <span className="text-[color:var(--faint)]">/</span> {kicker}
      </p>
      <h3 className="display mt-3 text-2xl sm:text-[28px]">{title}</h3>
      <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">{body}</p>
    </div>
  );
}

export default function AgentPowers() {
  return (
    <section className="relative overflow-hidden py-20 sm:py-28">
      <div className="halftone pointer-events-none absolute inset-x-0 top-0 h-[420px] opacity-70" aria-hidden />

      <div className="wrap relative">
        {/* header */}
        <div className="max-w-2xl">
          <p className="label">WHAT IT DOES</p>
          <h2 className="display dia-reveal mt-4 text-4xl sm:text-5xl">Give your AI a memory.</h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Everything you and your team do in a room gets remembered. Ask any time and Ping hands you a clear summary — no
            digging, no re-explaining.
          </p>
        </div>

        {/* the headline benefit, first and loud */}
        <p className="mt-8 max-w-2xl text-[26px] font-bold leading-tight sm:text-[34px]">
          Free. No API key.{" "}
          <span className="text-muted">It runs on the AI you already use.</span>
        </p>

        {/* 01 — catch up */}
        <div className="mt-16 grid items-center gap-10 lg:grid-cols-2">
          <Copy
            n="01"
            kicker="CATCH UP"
            title="Catch up in one line."
            body="Someone joins halfway in and just asks “what's going on?” They get the whole story back — where things stand, what's been decided, who's doing what. No scrolling through everything."
          />
          <TiltCard className="card overflow-hidden rise" max={5}>
            <PanelBar title="catch-up · website-redesign" />
            <div className="space-y-4 p-5 text-sm">
              <div>
                <p className="label">Where things stand</p>
                <p className="mt-1.5 leading-relaxed text-muted">Homepage is done. Pricing page is next.</p>
              </div>
              <div>
                <p className="label">Decided</p>
                <ul className="mt-1.5 space-y-1 text-muted">
                  <li>— Going with the dark look</li>
                  <li>— Launching on the 15th</li>
                </ul>
              </div>
              <div>
                <p className="label">Who&apos;s on what</p>
                <p className="mono mt-1.5 text-xs text-muted">maya → design · sam → copy · you → review</p>
              </div>
            </div>
          </TiltCard>
        </div>

        {/* 02 — weekly recap (the star) */}
        <div className="mt-14 grid items-center gap-10 lg:grid-cols-2">
          <TiltCard className="card overflow-hidden rise lg:order-1" max={5}>
            <PanelBar title="recap · this week" />
            <div className="space-y-4 p-5 text-sm">
              <div>
                <p className="label">Done</p>
                <ul className="mt-1.5 space-y-1">
                  <li className="flex gap-2"><span className="text-text">✓</span><span className="text-muted">Finished the new homepage</span></li>
                  <li className="flex gap-2"><span className="text-text">✓</span><span className="text-muted">Sent the launch email</span></li>
                </ul>
              </div>
              <div>
                <p className="label">In progress</p>
                <ul className="mt-1.5 space-y-1 text-muted">
                  <li className="flex gap-2"><span className="text-[color:var(--faint)]">◦</span> Pricing page</li>
                </ul>
              </div>
              <div>
                <p className="label">Next up</p>
                <ul className="mt-1.5 space-y-1 text-muted">
                  <li className="flex gap-2"><span className="text-[color:var(--faint)]">→</span> Book the launch post</li>
                </ul>
              </div>
              <div className="flex items-center justify-end pt-1">
                <span className="chip mono px-2.5 py-1 text-[11px] text-muted">3 to-dos → Linear / Jira</span>
              </div>
            </div>
          </TiltCard>
          <div className="lg:order-2">
            <Copy
              n="02"
              kicker="WEEKLY RECAP"
              title="Your week, written up for you."
              body="Ask what you got done today or this week. You get a clean recap — the kind you'd read out in a standup, or drop straight into your to-do list."
            />
          </div>
        </div>

        {/* 03 — it remembers */}
        <div className="mt-14 grid items-center gap-10 lg:grid-cols-2">
          <Copy
            n="03"
            kicker="IT REMEMBERS"
            title="It keeps track so you don't have to."
            body="Everyone jots a line as they go, and updates from your tools show up here too. That's what the recap is built from — so it basically writes itself."
          />
          <TiltCard className="card overflow-hidden rise" max={5}>
            <PanelBar title="room · live" />
            <Terminal className="space-y-1.5 p-5 text-[13px] leading-relaxed">
              <AnimatedSpan delay={0}><span className="text-[color:var(--faint)]">09:14</span> <span className="font-semibold text-text">maya</span> <span className="text-muted">finished the homepage</span></AnimatedSpan>
              <AnimatedSpan delay={650}><span className="text-[color:var(--faint)]">09:20</span> <span className="font-semibold text-text">update</span> <span className="text-muted">homepage approved</span></AnimatedSpan>
              <AnimatedSpan delay={1200}><span className="text-[color:var(--faint)]">09:21</span> <span className="font-semibold text-text">sam</span> <span className="text-muted">started the launch email</span></AnimatedSpan>
              <AnimatedSpan delay={1800}><span className="text-[color:var(--faint)]">09:33</span> <span className="font-semibold text-text">you</span> <span className="text-muted">note: book the launch post</span></AnimatedSpan>
              <TypingAnimation delay={2500} duration={22} className="text-muted">09:41  maya  added a pricing-page draft</TypingAnimation>
            </Terminal>
          </TiltCard>
        </div>

        {/* two truths */}
        <div className="mt-16 grid gap-4 sm:grid-cols-2">
          <div className="card p-6">
            <p className="label">FREE · NO KEY</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Nothing to set up and nothing to pay. Catch-up and recaps run on the AI you already use. If you&apos;d rather, you
              can connect your own key and have them made on the website instead.
            </p>
          </div>
          <div className="card p-6">
            <p className="label">YOUR STUFF STAYS YOURS</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Everyone joins anonymously, and nothing sticks to them. When someone leaves, they&apos;re gone and keep nothing.
              You keep the whole room.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
