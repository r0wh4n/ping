"use client";

import { useEffect, useRef, useState } from "react";

// The privacy page's signature: what you type, beside what our server keeps.
// A message is typed on "your phone", the Ping mark pulses as it's sealed, and
// the server's copy scrambles into ciphertext, then the next message. The photo
// row stays honest: photos lose their location but aren't sealed yet. Runs only
// while on screen; under reduced motion it holds one finished frame.
const LINES = ["see you at 7?", "the door code is 4412", "running late, save me a seat", "call me when you land"];
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const noise = (n: number) => Array.from({ length: n }, () => B64[(Math.random() * 64) | 0]).join("");
const STILL = "ping-e2e:v1:zA_Rv3GyJ8CH:InEvzkaJf7TEjNenG4wieWdmG2gWN";

export default function SealDemo() {
  const box = useRef<HTMLDivElement>(null);
  // Starts on a finished frame: what the server render, reduced motion and the
  // moment before the loop begins all show.
  const [typed, setTyped] = useState(LINES[0]);
  const [sealed, setSealed] = useState(STILL);
  const [sealing, setSealing] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let alive = true;
    let visible = false;
    let running = false;
    let timer = 0;
    let line = 0;
    const wait = (ms: number) => new Promise<void>((done) => (timer = window.setTimeout(done, ms)));

    async function run() {
      if (running) return;
      running = true;
      while (alive && visible) {
        const text = LINES[line % LINES.length];
        setSealed("");
        for (let k = 1; k <= text.length && alive && visible; k++) {
          setTyped(text.slice(0, k));
          await wait(55);
        }
        setSealing(true);
        for (let t = 0; t < 16 && alive && visible; t++) {
          setSealed("ping-e2e:v1:" + noise(20 + text.length));
          await wait(45);
        }
        setSealing(false);
        await wait(2400);
        line++;
      }
      running = false;
    }

    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) run();
    });
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
      clearTimeout(timer);
    };
  }, []);

  return (
    <div ref={box} className="card relative overflow-hidden p-5 shadow-[0_30px_80px_-30px_rgba(255,255,255,0.12)] sm:p-6" aria-hidden>
      <div className="flex items-center justify-between">
        <p className="label">On your phone</p>
        <p className="mono text-[11px] text-[color:var(--faint)]">@you → @maya</p>
      </div>
      <div className="mt-3 flex min-h-[40px] justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-[color:var(--text)] px-3.5 py-2 text-sm text-black">
          {typed}
          <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-black/70" style={{ animation: "caret 1s steps(1) infinite" }} />
        </p>
      </div>

      <div className="relative my-6 grid h-24 place-items-center">
        <span className="radar-ring" />
        <span className="radar-ring" />
        <span className="radar-ring" />
        <span
          className="relative z-10 grid h-14 w-14 place-items-center rounded-full border border-[color:var(--border-strong)] bg-black transition-transform duration-300"
          style={{ transform: sealing ? "scale(1.12)" : "scale(1)", boxShadow: sealing ? "0 0 46px rgba(255,255,255,0.35)" : "0 0 24px var(--glow)" }}
        >
          <svg viewBox="0 0 512 512" className="h-9 w-9">
            <circle cx="256" cy="256" r="150.5" fill="none" stroke="#fff" strokeOpacity="0.25" strokeWidth="18" />
            <circle cx="256" cy="256" r="104.5" fill="none" stroke="#fff" strokeOpacity="0.5" strokeWidth="18" />
            <circle cx="256" cy="256" r="58" fill="#f5f5f6" />
          </svg>
        </span>
        <span className="mono absolute right-0 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-[0.18em] text-[color:var(--faint)]">
          {sealing ? "sealing…" : "sealed"}
        </span>
      </div>

      <p className="label">On our servers</p>
      <p className="mono mt-3 min-h-[52px] break-all rounded-2xl rounded-bl-md border border-[color:var(--border-strong)] bg-black/60 px-3.5 py-2 text-[11.5px] leading-relaxed text-muted">
        {sealed || "…"}
      </p>

      <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed border-[color:var(--border-strong)] p-3">
        <span
          className="h-11 w-11 shrink-0 rounded-lg"
          style={{ background: "radial-gradient(circle at 32% 34%, #d9d9de 0 14%, transparent 15%), radial-gradient(ellipse 75% 45% at 45% 100%, #6e6e76 0 55%, transparent 56%), #2a2a30" }}
        />
        <div className="min-w-0">
          <p className="text-sm text-text">photo.jpg</p>
          <p className="text-xs leading-snug text-muted">Location removed before upload. Stored as sent: not sealed yet.</p>
        </div>
      </div>
    </div>
  );
}
