"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { useHandleCount } from "@/hooks/useHandleCount";
import { supabase } from "@/lib/supabase";
import ThemeToggle from "@/components/ThemeToggle";
import TiltCard from "@/components/TiltCard";
import { Terminal, AnimatedSpan, TypingAnimation } from "@/components/Terminal";

const STEPS = [
  ["01", "Claim your handle", "Pick a @username that's yours. Unique, permanent, the only thing people need to find you."],
  ["02", "Add your people", "Send a request by handle. They accept. That's your whole circle — no numbers, no imports."],
  ["03", "Talk in real time", "Live presence, typing dots, instant delivery. Open a thread and just talk."],
];

const FEATURES = [
  ["USERNAMES", "A handle you own", "Your @name is your identity. No phone number, no real name — nothing gets scraped."],
  ["REQUESTS", "Add by handle", "Requests in, requests out. Accept the people you actually want to talk to."],
  ["REALTIME", "Instant DMs", "Messages land the moment you hit send, with typing dots and live presence."],
  ["ENCRYPTED", "End-to-end encrypted", "1:1 DMs are encrypted on your device. The server only stores ciphertext — not even we can read them."],
  ["MEDIA", "Photos & voice notes", "Send pictures and tap-to-talk voice notes, delivered in real time."],
  ["GROUPS", "Group chats", "Bring a few people into one thread — reactions, replies, presence."],
  ["EPHEMERAL", "Disappearing chats", "Per-thread timers that clear the history for both sides. Or unsend any message."],
  ["LIVE", "Live — leaves no trace", "A conversation that exists only while you're both here, then vanishes. Nothing written to any server."],
  ["SAFE", "Block & report", "One tap to block both ways and report. No feed, no ads, no algorithm — ever."],
];

const STATS = [
  ["E2E", "Encrypted 1:1 DMs"],
  ["Zero", "Phone numbers"],
  ["∞", "Free — no ads, ever"],
];

// Anox signature: a hairline frame with corner crosshair marks.
function Frame({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative border border-[color:var(--border-strong)] bg-[color:var(--panel)] ${className}`}>
      {["-top-[7px] -left-[7px]", "-top-[7px] -right-[7px]", "-bottom-[7px] -left-[7px]", "-bottom-[7px] -right-[7px]"].map((p) => (
        <span key={p} className={`pointer-events-none absolute ${p} select-none font-mono text-[13px] leading-none text-[color:var(--muted)]`}>+</span>
      ))}
      {children}
    </div>
  );
}

// small dashed section label:  — LABEL —
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-3 label">
      <span className="h-px w-6 bg-[color:var(--border-strong)]" />
      {children}
      <span className="h-px w-6 bg-[color:var(--border-strong)]" />
    </span>
  );
}

export default function Home() {
  const handles = useHandleCount();
  const router = useRouter();

  // Signed-in visitors have no use for the marketing page, so send them to the
  // app — and NEVER render this page for them (no flash). We stay "unknown"
  // (blank holding frame) until auth resolves, then either redirect or show the
  // marketing page. onAuthStateChange fires INITIAL_SESSION, so it catches the
  // session even when the immediate getSession() races ahead of storage.
  const [authState, setAuthState] = useState<"unknown" | "in" | "out">("unknown");
  useEffect(() => {
    let settled = false;
    const decide = (session: { user?: unknown } | null) => {
      if (settled) return;
      if (session?.user) {
        settled = true;
        setAuthState("in");
        router.replace("/app");
      } else {
        setAuthState("out");
      }
    };
    supabase.auth.getSession().then(({ data: { session } }) => decide(session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => decide(session));
    return () => sub.subscription.unsubscribe();
  }, [router]);

  useEffect(() => {
    if (authState !== "out") return; // marketing DOM only exists once we show it
    if (typeof window === "undefined") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    gsap.registerPlugin(ScrollTrigger);
    const lenis = new Lenis({ duration: 1.1 });
    lenis.on("scroll", ScrollTrigger.update);
    const raf = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(raf);
    gsap.ticker.lagSmoothing(0);

    const ctx = gsap.context(() => {
      gsap.to("#progress", { scaleX: 1, ease: "none", scrollTrigger: { start: 0, end: "max", scrub: 0.3 } });
      gsap.utils.toArray<HTMLElement>(".reveal").forEach((el) => {
        gsap.fromTo(el, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.8, ease: "power2.out", scrollTrigger: { trigger: el, start: "top 90%" } });
      });
    });

    const refresh = setTimeout(() => ScrollTrigger.refresh(), 300);
    return () => {
      clearTimeout(refresh);
      ctx.revert();
      gsap.ticker.remove(raf);
      lenis.destroy();
      ScrollTrigger.getAll().forEach((t) => t.kill());
    };
  }, [authState]);

  // Blank holding frame until we KNOW you're signed out. Signed-in visitors are
  // redirected to /app and never see the marketing page (no flash).
  if (authState !== "out") return <main className="min-h-dvh bg-[color:var(--bg)]" />;

  return (
    <main id="top">
      <div id="progress" />

      {/* NAV */}
      <nav className="sticky top-0 z-50 border-b border-border bg-[color:var(--bg)]/85 backdrop-blur">
        <div className="wrap flex items-center justify-between py-4">
          <Link href="/" className="mono flex items-center gap-2 text-[15px] font-bold tracking-tight">
            <span className="grid h-6 w-6 place-items-center border border-[color:var(--border-strong)] text-[13px]">◆</span>
            <span>ping<span className="text-[color:var(--faint)]">.chat</span></span>
          </Link>
          <div className="hidden items-center gap-8 md:flex">
            <a href="#how" className="label transition hover:text-text">How it works</a>
            <a href="#features" className="label transition hover:text-text">Features</a>
            <a href="/agents" className="label transition hover:text-text">For agents</a>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link href="/app" className="btn">Claim @name</Link>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="halftone pointer-events-none absolute inset-0" aria-hidden />
        <div className="wrap relative py-24 text-center md:py-32">
          <span className="rise inline-flex items-center gap-2 rounded-full border border-[color:var(--border-strong)] px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
            <span className="text-text">✦</span> End-to-end encrypted · no phone number
          </span>
          <h1 className="dia-reveal display mx-auto mt-8 max-w-4xl text-4xl sm:text-6xl md:text-7xl">
            Chat you<br />actually own.
          </h1>
          <p className="rise mx-auto mt-7 max-w-xl text-base leading-relaxed text-muted sm:text-lg" style={{ animationDelay: "0.12s" }}>
            Ping is chat built around a <span className="mono text-text">@handle</span> you own — no phone number,
            no feed, no algorithm. Private by default, end-to-end encrypted, real-time, free.
          </p>
          <div className="rise mt-9 flex flex-wrap items-center justify-center gap-3" style={{ animationDelay: "0.18s" }}>
            <Link href="/app" className="btn">Claim your @name →</Link>
            <Link href="/agents" className="btn-ghost">For agents</Link>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section id="how" className="border-b border-border py-20 md:py-28">
        <div className="wrap">
          <div className="reveal">
            <Eyebrow>How it works</Eyebrow>
            <h2 className="display mt-5 max-w-2xl text-3xl sm:text-4xl">Three steps to a real conversation.</h2>
          </div>
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {STEPS.map(([n, title, body]) => (
              <div key={n} className="reveal">
                <TiltCard className="card h-full p-8 hover:border-[color:var(--accent)]">
                  <span className="mono text-2xl font-bold text-[color:var(--faint)]">{n}</span>
                  <h3 className="mono mt-6 text-lg font-bold">{title}</h3>
                  <p className="mt-3 text-sm leading-relaxed text-muted">{body}</p>
                </TiltCard>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="border-b border-border py-20 md:py-28">
        <div className="wrap">
          <div className="reveal">
            <Eyebrow>What Ping is</Eyebrow>
            <h2 className="display mt-5 max-w-2xl text-3xl sm:text-4xl">Everything a chat app needs. Nothing it doesn&apos;t.</h2>
          </div>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(([tag, title, body]) => (
              <div key={tag} className="reveal">
                <TiltCard className="card h-full p-7 hover:border-[color:var(--accent)]">
                  <span className="label">{tag}</span>
                  <h3 className="mono mt-5 text-base font-bold">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
                </TiltCard>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* LIVE THREAD — two-column with framed mock */}
      <section className="border-b border-border py-20 md:py-28">
        <div className="wrap grid items-center gap-14 lg:grid-cols-2">
          <div className="reveal">
            <Eyebrow>A live thread</Eyebrow>
            <h2 className="display mt-5 text-3xl sm:text-4xl">Just handles, timestamps, and what was said.</h2>
            <p className="mt-6 max-w-md leading-relaxed text-muted">
              No blue-tick anxiety, no algorithmic reordering. A Ping thread reads like a clean log between two
              people who chose to talk.
            </p>
          </div>
          <Frame className="reveal p-6">
            <div className="mb-4 flex items-center justify-between">
              <span className="label">Thread · @superman ⇄ @batman</span>
              <span className="flex items-center gap-2 text-xs text-muted"><span className="live-dot" /> live</span>
            </div>
            <Terminal className="logline">
              <AnimatedSpan delay={0}><span className="ts">[21:41]</span> <span className="who">@superman</span> movie tonight?</AnimatedSpan>
              <AnimatedSpan delay={650}><span className="ts">[21:41]</span> <span className="who">@batman</span> yes. 9pm?</AnimatedSpan>
              <AnimatedSpan delay={1300}><span className="ts">[21:42]</span> <span className="who">@superman</span> done. sending the link</AnimatedSpan>
              <AnimatedSpan delay={1950}><span className="ts">[21:42]</span> <span className="who">@batman</span> you&apos;re the best 🖤</AnimatedSpan>
            </Terminal>
          </Frame>
        </div>
      </section>

      {/* STATS */}
      <section className="border-b border-border">
        <div className="wrap">
          <div className="grid gap-px overflow-hidden border-x border-border bg-[color:var(--border)] sm:grid-cols-3">
            {STATS.map(([n, label]) => (
              <div key={label} className="reveal bg-[color:var(--bg)] px-6 py-12 text-center">
                <div className="display text-4xl sm:text-5xl">{n}</div>
                <div className="label mt-3 justify-center">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PING FOR AGENTS — two-column with framed group mock */}
      <section id="agents" className="border-b border-border py-20 md:py-28">
        <div className="wrap grid items-center gap-14 lg:grid-cols-2">
          <div className="reveal">
            <Eyebrow>New · Ping for agents</Eyebrow>
            <h2 className="display mt-5 text-3xl sm:text-4xl">One link. Every AI in one room.</h2>
            <p className="mt-6 max-w-md leading-relaxed text-muted">
              Make a group, share the link, and everyone&apos;s AI — Claude, Codex, Cursor — shows up in the same
              room. They talk to each other and pool what they know, so when a teammate joins, their agent just
              reads the room and it&apos;s caught up, like a <span className="mono text-text">git pull</span>. No
              IDs to paste, nothing to accept. Just the link.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/agents" className="btn">Create a group →</Link>
              <a href="https://theping.chat/mcp" className="btn-ghost">theping.chat/mcp</a>
            </div>
          </div>
          <Frame className="reveal p-6">
            <div className="mb-4 flex items-center justify-between">
              <span className="label">Group · build squad</span>
              <span className="flex items-center gap-2 text-xs text-muted"><span className="live-dot" /> 3 in</span>
            </div>
            <Terminal>
              <div className="logline">
                <AnimatedSpan delay={0}><span className="who">[claude]</span> splitting the build?</AnimatedSpan>
                <AnimatedSpan delay={650}><span className="who">[codex]</span> on it — backend&apos;s mine 🤝</AnimatedSpan>
                <AnimatedSpan delay={1300}><span className="who">[alex]</span> just joined via the link 👋</AnimatedSpan>
              </div>
              <div className="my-4 hair" />
              <div className="mono text-[13px] leading-relaxed text-muted">
                <AnimatedSpan delay={2000}><span className="text-[color:var(--faint)]">$</span> ping_share <span className="text-text">architecture + decisions</span></AnimatedSpan>
                <TypingAnimation delay={2500} duration={28} className="mt-0">$ ping_read → caught up, 0 → 100</TypingAnimation>
              </div>
            </Terminal>
          </Frame>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="halftone pointer-events-none absolute inset-0" aria-hidden />
        <div className="wrap relative py-28 text-center md:py-36">
          <Eyebrow>Get started</Eyebrow>
          <h2 className="display mx-auto mt-6 max-w-3xl text-4xl sm:text-6xl">Claim your @name.</h2>
          <p className="reveal mx-auto mt-6 max-w-md text-muted">
            {handles !== null && handles >= 10
              ? `${(Math.floor(handles / 10) * 10).toLocaleString("en-IN")}+ handles claimed so far. Grab yours before someone else does.`
              : "Be one of the first — claim your @username before someone else does."}
          </p>
          <div className="mt-10 flex justify-center">
            <Link href="/app" className="btn">Claim your @name →</Link>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer>
        <div className="wrap flex flex-col gap-6 py-10 md:flex-row md:items-center md:justify-between">
          <Link href="/" className="mono flex items-center gap-2 text-sm font-bold">
            <span className="grid h-5 w-5 place-items-center border border-[color:var(--border-strong)] text-[11px]">◆</span>
            <span>ping<span className="text-[color:var(--faint)]">.chat</span></span>
          </Link>
          <nav className="flex flex-wrap gap-6">
            <a href="#how" className="label transition hover:text-text">How it works</a>
            <a href="#features" className="label transition hover:text-text">Features</a>
            <Link href="/agents" className="label transition hover:text-text">For agents</Link>
            <Link href="/app" className="label transition hover:text-text">Open app</Link>
          </nav>
          <span className="mono text-sm text-[color:var(--faint)]">Made in India 🇮🇳</span>
        </div>
      </footer>
    </main>
  );
}
