"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";

// A room that updates itself. Three people, three agents, three machines: each
// request is typed, the agent works, and its report leaves the machine sealed. It
// reaches the room as ciphertext and opens there, which is the end-to-end
// encryption made visible.
//
// Every line is worded the way that client really posts. Codex and Command Code
// go through Ping's hook adapters, so what they share follows /ping detail (the
// tabs). Claude Code's own hook quotes the request and is not affected by it.

type Detail = "labels" | "files" | "task";
const DETAILS: { id: Detail; label: string }[] = [
  { id: "labels", label: "Label" },
  { id: "files", label: "+ file names" },
  { id: "task", label: "+ the request" },
];

type Agent = { who: string; client: string; os: string; request: string; tool: string; done: string };
const AGENTS: Agent[] = [
  { who: "maya", client: "Claude Code", os: "macOS", request: "build a pricing page", tool: "write  app/pricing/page.tsx", done: "committed · Add a pricing page" },
  { who: "dev", client: "Codex", os: "Linux", request: "fix the login redirect", tool: "edit   api/auth/callback.ts", done: "tests pass" },
  { who: "rohan", client: "Command Code", os: "Windows", request: "delete the old snake game", tool: "Remove-Item snake.html", done: "removed" },
];

const CLAUDE = "pricing-site · “build a pricing page”";
type Step = { at: number; i: number; phase: 1 | 2 | 3; post?: (d: Detail) => string };
const STEPS: Step[] = [
  { at: 0, i: 0, phase: 1 },
  { at: 1500, i: 0, phase: 2, post: () => `${CLAUDE} · working on the frontend` },
  { at: 2600, i: 1, phase: 1 },
  { at: 4100, i: 1, phase: 2, post: (d) => "Codex · started: fixing" + (d === "task" ? ' — "fix the login redirect"' : "") },
  { at: 5200, i: 2, phase: 1 },
  { at: 6600, i: 2, phase: 2, post: (d) => "Command Code · started: deleting" + (d === "task" ? ' — "delete the old snake game"' : "") },
  { at: 7900, i: 2, phase: 3, post: (d) => "Command Code · finished: deleting · " + (d === "labels" ? "working on the frontend" : "deleted snake.html") },
  { at: 9300, i: 1, phase: 3, post: (d) => "Codex · finished: fixing · " + (d === "labels" ? "working on the backend" : "edited callback.ts") },
  { at: 10800, i: 0, phase: 3, post: () => `${CLAUDE} · shipped a change to the frontend — "Add a pricing page"` },
];
const LOOP_MS = 15000;
const FEED_MAX = 6;

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const scramble = (s: string) => s.replace(/\S/g, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]);

// Ciphertext that resolves, left to right, into the line it carried.
export function Decrypt({ text, reduced, delay = 0 }: { text: string; reduced: boolean; delay?: number }) {
  const [shown, setShown] = useState(() => (reduced ? text : scramble(text)));
  const [open, setOpen] = useState(reduced);
  useEffect(() => {
    if (reduced) return;
    const ticks = 22;
    let n = 0;
    let id: ReturnType<typeof setInterval> | undefined;
    const start = setTimeout(() => {
      id = setInterval(() => {
        n += 1;
        const keep = Math.floor((n / ticks) * text.length);
        setShown(text.slice(0, keep) + scramble(text.slice(keep)));
        if (n >= ticks) {
          clearInterval(id);
          setShown(text);
          setOpen(true);
        }
      }, 38);
    }, delay);
    return () => {
      clearTimeout(start);
      clearInterval(id);
    };
  }, [text, reduced, delay]);
  return (
    <>
      <Lock open={open} />
      <span className={open ? "text-text" : "text-[color:var(--faint)]"}>{shown}</span>
    </>
  );
}

function Lock({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={`mr-1.5 inline-block h-3 w-3 shrink-0 align-[-1px] transition-colors duration-500 ${open ? "text-[color:var(--faint)]" : "text-[color:var(--brand)]"}`} aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d={open ? "M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" : "M5.5 7V5a2.5 2.5 0 0 1 5 0v2"} fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

// Mounted only once its line starts, so every loop types from the first letter.
// Letter by letter only here: it is the person's own input, typed.
function Typed({ text, reduced }: { text: string; reduced: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (reduced) return;
    let k = 0;
    const id = setInterval(() => {
      k += 1;
      setN(k);
      if (k >= text.length) clearInterval(id);
    }, 34);
    return () => clearInterval(id);
  }, [text, reduced]);
  const shown = reduced ? text.length : n;
  return (
    <>
      {text.slice(0, shown)}
      {shown < text.length && <span className="ml-px inline-block h-3.5 w-1.5 animate-pulse bg-[color:var(--text)] align-[-2px]" />}
    </>
  );
}

type FeedLine = { id: number; who: string; post: (d: Detail) => string };

// What someone who asked for less motion sees: the room after one full loop.
const FINAL_FEED: FeedLine[] = STEPS.filter((s) => s.post)
  .slice(-FEED_MAX)
  .map((s, id) => ({ id, who: AGENTS[s.i].who, post: s.post! }));
const FINAL_PHASE = [3, 3, 3];

export default function LiveRoom() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const reduced = useReducedMotion();
  const [detail, setDetail] = useState<Detail>("labels");
  const [phase, setPhase] = useState<number[]>([0, 0, 0]);
  const [sending, setSending] = useState<number | null>(null);
  const [feed, setFeed] = useState<FeedLine[]>([]);

  // Run only while on screen: an animation nobody can see should not cost a battery.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reduced || !visible) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    let seq = 0;
    const run = () => {
      setPhase([0, 0, 0]);
      setFeed([]);
      timers = STEPS.map((s) =>
        setTimeout(() => {
          setPhase((p) => p.map((v, k) => (k === s.i ? s.phase : v)));
          if (s.post) {
            setSending(s.i);
            setTimeout(() => setSending((c) => (c === s.i ? null : c)), 900);
            const line = { id: seq++, who: AGENTS[s.i].who, post: s.post };
            setFeed((f) => [...f, line].slice(-FEED_MAX));
          }
        }, s.at)
      );
      timers.push(setTimeout(run, LOOP_MS));
    };
    run();
    return () => timers.forEach(clearTimeout);
  }, [visible, reduced]);

  const shownPhase = reduced ? FINAL_PHASE : phase;
  const shownFeed = reduced ? FINAL_FEED : feed;

  return (
    <div ref={ref}>
      <div className="frame">
        <div className="frame-screen">
          {/* window bar + what Codex and Command Code share */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex items-center gap-2" aria-hidden="true">
              <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--border-strong)]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--border-strong)]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--border-strong)]" />
              <span className="mono ml-3 text-[12px] text-muted">launch-squad — ping</span>
            </div>
            <div className="seg" role="group" aria-label="What Codex and Command Code share">
              {DETAILS.map((d) => (
                <button key={d.id} type="button" aria-pressed={detail === d.id} onClick={() => setDetail(d.id)}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-px bg-[color:var(--border)] lg:grid-cols-[1fr_1.15fr]" aria-hidden="true">
            {/* the three machines */}
            <div className="flex flex-col gap-px">
              {AGENTS.map((a, i) => (
                <div key={a.who} className="relative bg-[color:var(--panel)] p-4">
                  <div className="flex items-center justify-between">
                    <span className="mono text-[12px] text-text">
                      <span className={`mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle transition-colors ${shownPhase[i] > 0 && shownPhase[i] < 3 ? "animate-pulse bg-[color:var(--brand)]" : "bg-[color:var(--faint)]"}`} />
                      {a.who} <span className="text-[color:var(--faint)]">·</span> {a.client}
                    </span>
                    <span className={`mono rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] transition-colors duration-300 ${sending === i ? "bg-[color:color-mix(in_srgb,var(--brand)_18%,transparent)] text-[color:var(--brand)]" : "text-[color:var(--faint)]"}`}>
                      {sending === i ? "sealed ↗ room" : a.os}
                    </span>
                  </div>
                  <div className="mono mt-3 min-h-[60px] text-[12.5px] leading-relaxed">
                    <div className="text-muted">
                      <span className="text-[color:var(--faint)]">›</span> {shownPhase[i] >= 1 && <Typed text={a.request} reduced={reduced} />}
                    </div>
                    <div className={`whitespace-pre transition-opacity duration-300 ${shownPhase[i] >= 2 ? "opacity-100" : "opacity-0"} text-[color:var(--faint)]`}>  {a.tool}</div>
                    <div className={`transition-opacity duration-300 ${shownPhase[i] >= 3 ? "opacity-100" : "opacity-0"} text-muted`}>  ✓ {a.done}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* the room */}
            <div className="flex flex-col bg-[color:var(--bg-2)]">
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <span className="mono text-[12px] text-text"># launch-squad</span>
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-[color:var(--faint)]">
                  <span className="live-dot" /> 3 agents working
                </span>
              </div>
              <div className="mono flex min-h-[300px] flex-1 flex-col justify-end gap-2.5 px-4 py-4 text-[12.5px] leading-relaxed">
                {shownFeed.length === 0 && <div className="text-[color:var(--faint)]">waiting for the first update…</div>}
                {shownFeed.map((l) => (
                  <div key={`${l.id}:${detail}`} className="liveroom-in min-w-0 break-words">
                    <span className="mr-2 text-muted">{l.who} ·</span>
                    <Decrypt text={l.post(detail)} reduced={reduced} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="mt-4 text-center text-[12.5px] leading-relaxed text-[color:var(--faint)]">
        Each person picks for their own machine with <span className="mono text-muted">/ping detail labels · files · task</span>.
        Claude Code&apos;s hook always includes the request&apos;s first line.
      </p>
    </div>
  );
}
