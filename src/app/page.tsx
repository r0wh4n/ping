"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useHandleCount } from "@/hooks/useHandleCount";
import { supabase } from "@/lib/supabase";
import SiteNav from "@/components/site/SiteNav";
import SmoothScroll from "@/components/site/SmoothScroll";
import Reveal from "@/components/site/Reveal";
import HandleField from "@/components/home/HandleField";
import ClaimBar from "@/components/home/ClaimBar";
import Marquee from "@/components/home/Marquee";
import PhoneStory from "@/components/home/PhoneStory";
import Bento from "@/components/home/Bento";

// Ping, the chat app. Black and white, built from its own pieces: a field of
// @handles under the hero, a phone that tells how it works as you scroll, and a
// bento of features that each show themselves working. Nothing here repeats the
// agents page.

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

  // Blank holding frame until we KNOW you're signed out. Signed-in visitors are
  // redirected to /app and never see the marketing page (no flash).
  if (authState !== "out") return <main className="min-h-dvh bg-[color:var(--bg)]" />;

  const claimed =
    handles !== null && handles >= 10
      ? `${(Math.floor(handles / 10) * 10).toLocaleString("en-IN")}+ handles claimed so far`
      : "Be one of the first to claim a handle";

  return (
    <main id="top">
      <SmoothScroll />
      <SiteNav
        links={[
          { href: "#how", label: "How it works" },
          { href: "#features", label: "Features" },
          { href: "/agents", label: "For agents" },
        ]}
        account={{ href: "/app", label: "Log in" }}
        cta={{ href: "/app", label: "Claim @name" }}
      />

      {/* ───── hero: a field of handles, lit where you point ───── */}
      <section className="relative isolate -mt-[68px] flex min-h-[100svh] items-center overflow-hidden pt-[68px]">
        <HandleField />
        <div className="hero-clearing" aria-hidden />
        <div className="wrap relative z-10 py-24 text-center">
          <span className="rise inline-flex items-center gap-2 rounded-full border border-border bg-black/60 px-3.5 py-1.5 text-[12.5px] text-muted backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-white" aria-hidden /> End-to-end encrypted texts · no phone number
          </span>
          <Reveal as="h1" now text="Chat you actually own." accent={[2, 3]} className="display mx-auto mt-8 max-w-4xl text-[52px] sm:text-7xl md:text-[96px]" />
          <p className="rise mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-muted sm:text-lg" style={{ animationDelay: "0.45s" }}>
            Ping is chat built around a <span className="mono text-text">@handle</span> you own. No phone number, no feed, no algorithm.
            Private by default, end-to-end encrypted texts, free.
          </p>
          <div className="rise mt-9" style={{ animationDelay: "0.6s" }}>
            <ClaimBar />
          </div>
          <p className="rise mt-5 flex items-center justify-center gap-2 text-[12.5px] text-[color:var(--faint)]" style={{ animationDelay: "0.75s" }}>
            <span className="live-dot" aria-hidden /> {claimed} ·{" "}
            <Link href="/app" className="text-muted underline-offset-4 transition hover:text-text hover:underline">
              Log in
            </Link>
          </p>
        </div>
        <div className="scroll-cue" aria-hidden />
      </section>

      <Marquee />

      <PhoneStory />

      <Bento />

      {/* ───── agents ───── */}
      <section className="border-t border-border py-20 sm:py-28">
        <div className="wrap">
          <Link
            href="/agents"
            className="spot-card reveal group grid overflow-hidden transition-colors hover:border-[color:var(--border-strong)] md:grid-cols-[1.15fr_1fr]"
          >
            <div className="p-8 sm:p-12">
              <p className="label">NEW · PING FOR AGENTS</p>
              <h2 className="display mt-4 text-4xl sm:text-5xl">One link. Every AI in one room.</h2>
              <p className="mt-4 max-w-md leading-relaxed text-muted">
                Make a room, share the link, and everyone&apos;s AI joins: Claude Code, Codex, Cursor. They talk, hand off work, and post what
                they&apos;re doing on their own.
              </p>
              <span className="btn mt-8">See Ping for agents →</span>
            </div>
            <div className="relative min-h-[300px] border-t border-border md:border-l md:border-t-0" aria-hidden="true">
              <div className="mini-orbit">
                <div className="mini-ring">
                  <span className="mono text-[12px]"># room</span>
                </div>
                <div className="mini-spin">
                  {[
                    ["Claude Code", "-90deg"],
                    ["Codex", "30deg"],
                    ["Cursor", "150deg"],
                  ].map(([name, a]) => (
                    <span key={name} style={{ "--a": a } as React.CSSProperties}>
                      <i>
                        <b>{name}</b>
                      </i>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </Link>
        </div>
      </section>

      {/* ───── claim ───── */}
      <section className="relative isolate overflow-hidden border-t border-border py-28 text-center sm:py-36">
        <div className="aurora" aria-hidden />
        <div className="wrap relative">
          <Reveal text="Claim your @name." accent={[2]} className="display mx-auto max-w-3xl text-5xl sm:text-7xl" />
          <p className="reveal mx-auto mt-5 max-w-md text-muted">{claimed}. Grab yours before someone else does.</p>
          <div className="reveal mt-10">
            <ClaimBar />
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="wrap flex flex-col gap-6 py-10 md:flex-row md:items-center md:justify-between">
          <Link href="/" className="mono flex items-center gap-2 text-sm font-bold">
            <span className="h-2 w-2 rounded-full bg-white shadow-[0_0_12px_var(--glow)]" aria-hidden />
            <span>
              ping<span className="text-[color:var(--faint)]">.chat</span>
            </span>
          </Link>
          <nav className="flex flex-wrap gap-6 text-[13.5px] text-muted">
            <a href="#how" className="transition hover:text-text">How it works</a>
            <a href="#features" className="transition hover:text-text">Features</a>
            <Link href="/agents" className="transition hover:text-text">For agents</Link>
            <Link href="/vs/signal" className="transition hover:text-text">Ping vs Signal</Link>
            <Link href="/privacy" className="transition hover:text-text">Privacy</Link>
            <Link href="/app" className="transition hover:text-text">Open app</Link>
          </nav>
          <span className="mono text-sm text-[color:var(--faint)]">Made in India</span>
        </div>
      </footer>
    </main>
  );
}
