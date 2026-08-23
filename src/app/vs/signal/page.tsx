import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Ping vs Signal — private chat with no phone number | theping.chat",
  description:
    "Signal is excellent, but it needs your phone number. Ping is an open-source chat app where your identity is a @handle you pick — no phone, no email, end-to-end encrypted DMs. Here's an honest Ping vs Signal comparison.",
  keywords: [
    "signal alternative",
    "chat without phone number",
    "anonymous chat app",
    "private messenger no phone number",
    "end to end encrypted chat",
    "open source messenger",
    "ping vs signal",
  ],
  alternates: { canonical: "https://theping.chat/vs/signal" },
  openGraph: {
    title: "Ping vs Signal — private chat with no phone number",
    description:
      "An open-source, anonymous chat app where your identity is just a @handle. No phone number, no email — with end-to-end encrypted DMs.",
    url: "https://theping.chat/vs/signal",
    siteName: "Ping",
    type: "website",
    images: [{ url: "https://theping.chat/og.png", width: 1600, height: 900, alt: "Ping — chat you actually own" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ping vs Signal — private chat with no phone number",
    description: "Open-source, anonymous chat. Your identity is a @handle you pick — no phone, no email.",
    images: ["https://theping.chat/og.png"],
  },
};

// [feature, Ping, Signal, whether Ping is the standout on this row]
const ROWS: [string, string, string, boolean][] = [
  ["Sign-up identity", "A @handle you pick", "Your phone number", true],
  ["Phone number required", "No — never", "Yes, to register", true],
  ["Email required", "No", "No", false],
  ["End-to-end encryption", "Yes — 1:1 DMs", "Yes — every chat & call", false],
  ["Open source", "Yes — MIT", "Yes — AGPL/GPL", false],
  ["Runs in a browser", "Yes — nothing to install (PWA)", "No — app install required", true],
  ["Disappearing messages", "Yes — countdown starts after it's seen", "Yes — timer from send", true],
  ["View-once photos & video", "Yes", "No", true],
  ["“Live” no-trace mode", "Yes — nothing written to any server", "No", true],
  ["Voice & video calls", "Not yet", "Yes", false],
  ["Independently audited", "Not yet — new & indie", "Yes — mature & audited", false],
  ["Price", "Free — no ads", "Free — nonprofit", false],
];

const FAQ: [string, string][] = [
  [
    "Is there a chat app that doesn't need a phone number?",
    "Yes — Ping. You sign up with just a @handle and a password: no phone number, no email, no real name. Nothing ties your account to your real-world identity, so there's nothing to scrape, sell, or leak.",
  ],
  [
    "Is Ping as secure as Signal?",
    "Signal is the gold standard: independently audited for years, every chat and call end-to-end encrypted, run by a well-funded nonprofit. Ping is newer and indie — its 1:1 DMs are end-to-end encrypted (the server only ever stores ciphertext), but it hasn't had a formal audit yet and group chats aren't E2E. If your threat model is a nation-state, use Signal. If you want everyday privacy without handing over your phone number, that's exactly what Ping is for — and it's open source, so you can verify it yourself.",
  ],
  [
    "Is Ping open source?",
    "Yes. Ping is MIT-licensed and the full source is on GitHub at github.com/r0wh4n/ping. Don't trust us — read the code.",
  ],
  [
    "Can I use Ping without installing an app?",
    "Yes. Ping runs in any modern browser and installs as a PWA (add-to-home-screen) on phones — no app store, no download.",
  ],
];

export default function VsSignalPage() {
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map(([q, a]) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };

  return (
    <main className="min-h-dvh bg-[color:var(--bg)] text-[color:var(--text)]">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }} />

      {/* nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-[color:var(--bg)]/85 backdrop-blur">
        <div className="wrap flex items-center justify-between py-4">
          <Link href="/" className="mono flex items-center gap-2 text-[15px] font-bold tracking-tight">
            <span className="grid h-6 w-6 place-items-center border border-[color:var(--border-strong)] text-[13px]">◆</span>
            <span>ping<span className="text-[color:var(--faint)]">.chat</span></span>
          </Link>
          <Link href="/app" className="btn">Claim your @name</Link>
        </div>
      </nav>

      {/* hero */}
      <section className="border-b border-border">
        <div className="wrap py-16 md:py-24">
          <p className="label">Comparison · Ping vs Signal</p>
          <h1 className="display mt-5 max-w-3xl text-4xl sm:text-5xl md:text-6xl">
            The private chat app that doesn&apos;t want your phone number.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
            Signal is a superb, audited messenger — and we recommend it for high-risk users. But it still asks for the
            one identifier wired to your bank, your ID, and your face: your <strong className="text-text">phone number</strong>.
            Ping takes a different bet — your whole identity is a <span className="mono text-text">@handle</span> you pick,
            with end-to-end encrypted DMs and nothing to hand over.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/app" className="btn">Claim your @name →</Link>
            <a href="https://github.com/r0wh4n/ping" className="btn-ghost" rel="noopener">Read the source</a>
          </div>
        </div>
      </section>

      {/* comparison table */}
      <section className="border-b border-border">
        <div className="wrap py-14 md:py-20">
          <h2 className="display text-2xl sm:text-3xl">Ping vs Signal, side by side</h2>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="label border-b border-[color:var(--border-strong)]">
                  <th className="py-3 pr-4 font-normal">Feature</th>
                  <th className="py-3 pr-4 font-normal text-text">Ping</th>
                  <th className="py-3 font-normal">Signal</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map(([feature, ping, signal, win]) => (
                  <tr key={feature} className="border-b border-border align-top">
                    <td className="py-3.5 pr-4 text-sm text-muted">{feature}</td>
                    <td className={`py-3.5 pr-4 text-sm ${win ? "font-semibold text-text" : "text-text"}`}>{ping}</td>
                    <td className="py-3.5 text-sm text-muted">{signal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-[color:var(--faint)]">
            Signal details reflect its public docs at time of writing. Something out of date?{" "}
            <a href="https://github.com/r0wh4n/ping" className="underline" rel="noopener">Open an issue</a>.
          </p>
        </div>
      </section>

      {/* honesty: where Signal wins */}
      <section className="border-b border-border">
        <div className="wrap py-14 md:py-20">
          <h2 className="display text-2xl sm:text-3xl">Where Signal is stronger</h2>
          <p className="mt-4 max-w-2xl text-muted">
            We&apos;re not here to trash Signal — we use it too. Being straight with you:
          </p>
          <ul className="mt-6 grid max-w-3xl gap-3 text-sm text-muted sm:grid-cols-2">
            {[
              "Years of independent security audits and a public track record.",
              "End-to-end encryption on every chat, group, and voice/video call.",
              "A large, established user base — the people you want to reach are already there.",
              "A well-funded nonprofit with a clear, battle-tested threat model.",
            ].map((t) => (
              <li key={t} className="rounded-lg border border-border bg-[color:var(--panel)] px-4 py-3">{t}</li>
            ))}
          </ul>
          <p className="mt-6 max-w-2xl text-muted">
            Ping isn&apos;t trying to replace Signal for activists dodging a government. It&apos;s built for the millions of
            everyday conversations that simply shouldn&apos;t require your phone number — a date, a marketplace buyer, a new
            group, a stranger who might become a friend.
          </p>
        </div>
      </section>

      {/* what makes ping different */}
      <section className="border-b border-border">
        <div className="wrap py-14 md:py-20">
          <h2 className="display text-2xl sm:text-3xl">What you get with Ping</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["A @handle, not a number", "Sign up with a username and password. No phone, no email, no real name — nothing to scrape or leak."],
              ["End-to-end encrypted DMs", "1:1 messages are encrypted on your device; the server only ever stores ciphertext. We can't read them."],
              ["Disappearing after it's seen", "Vanish timers start only once the other person actually opens the message — never before."],
              ["View-once photos & video", "Send a snap that opens once, then it's gone (or save it to the chat if you both want to keep it)."],
              ["Live, no-trace mode", "A conversation that exists only while you're both there — nothing written to any server."],
              ["Open source, free forever", "MIT-licensed, no ads, no algorithm, no feed. Read the code and host your own if you like."],
            ].map(([t, d]) => (
              <div key={t} className="rounded-lg border border-border bg-[color:var(--panel)] p-5">
                <h3 className="mono text-sm font-semibold text-text">{t}</h3>
                <p className="mt-2 text-sm text-muted">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-b border-border">
        <div className="wrap py-14 md:py-20">
          <h2 className="display text-2xl sm:text-3xl">Frequently asked</h2>
          <div className="mt-8 max-w-3xl divide-y divide-[color:var(--border)]">
            {FAQ.map(([q, a]) => (
              <div key={q} className="py-5">
                <h3 className="text-base font-semibold text-text">{q}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section>
        <div className="wrap py-16 text-center md:py-24">
          <h2 className="display mx-auto max-w-2xl text-3xl sm:text-4xl">Chat you actually own.</h2>
          <p className="mx-auto mt-5 max-w-xl text-muted">
            Claim your <span className="mono text-text">@handle</span> in a few seconds. No phone number, ever.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/app" className="btn">Claim your @name →</Link>
            <a href="https://github.com/r0wh4n/ping" className="btn-ghost" rel="noopener">Star on GitHub</a>
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="wrap flex flex-col items-center justify-between gap-3 py-8 text-sm text-muted sm:flex-row">
          <Link href="/" className="mono font-bold">ping<span className="text-[color:var(--faint)]">.chat</span></Link>
          <span className="text-[color:var(--faint)]">Private by default · end-to-end encrypted · open source</span>
        </div>
      </footer>
    </main>
  );
}
