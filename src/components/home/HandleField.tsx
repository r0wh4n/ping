"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";

// The hero's ground: a field of @handles lit by a spotlight that follows the
// pointer, and wanders on its own when there is none (a phone, an idle mouse).
// Every so often one handle is pinged: it flashes white, someone got a message.
// A fixed list in a fixed order, so the server and the browser draw the same field.
const NAMES = ["maya", "rohan", "neo", "zara", "dev", "ana", "sam", "lee", "kai", "noor", "ivy", "arjun", "mia", "leo", "sara", "omar", "yuki", "ravi", "nina", "theo", "aria", "jay", "luna", "felix", "isha", "max", "eli", "tara", "ben", "rhea", "zoe", "adi", "kian", "mira", "oli", "vik", "nora", "sid", "ella", "raj"];
const CELLS = Array.from({ length: 220 }, (_, i) => NAMES[(i * 7 + Math.floor(i / 9)) % NAMES.length]);

// The spotlight is a lens: a box with a soft round mask, moved by transform,
// holding a lit copy of the field that moves the opposite way so it stays put
// over the dim one. Each frame changes two transforms and nothing else, so the
// compositor moves it without restyling or repainting the 440 handles.
const R = 240; // spotlight radius, px; matches .hf-lens in globals.css

export default function HandleField() {
  const box = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLDivElement>(null);
  const lit = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = box.current;
    const lensEl = lens.current;
    const litEl = lit.current;
    const host = el?.parentElement;
    if (!el || !lensEl || !litEl || !host) return;
    let [w, h] = [el.offsetWidth, el.offsetHeight];
    let [tx, ty, x, y] = [0.5, 0.42, 0.5, 0.42];
    // Whole pixels: the lit copy's net offset stays exactly zero, so its text is
    // never resampled.
    const place = () => {
      const px = Math.round(x * w - R);
      const py = Math.round(y * h - R);
      lensEl.style.transform = `translate3d(${px}px,${py}px,0)`;
      litEl.style.transform = `translate3d(${-px}px,${-py}px,0)`;
    };
    place();
    lensEl.dataset.on = "";
    const ro = new ResizeObserver(() => {
      [w, h] = [el.offsetWidth, el.offsetHeight];
      place();
    });
    ro.observe(el);
    if (reduced) return () => ro.disconnect();

    const cells = el.querySelectorAll<HTMLElement>(".hf-base .hf-cell");
    let raf = 0;
    let running = false;
    let lastPing = 0;
    let idleSince = 0;

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      tx = (e.clientX - r.left) / r.width;
      ty = (e.clientY - r.top) / r.height;
      idleSince = performance.now();
    };
    const ping = () => {
      const c = cells[Math.floor(Math.random() * cells.length)];
      if (!c) return;
      c.dataset.ping = "";
      setTimeout(() => delete c.dataset.ping, 1600);
    };
    const tick = (now: number) => {
      if (now - idleSince > 2500) {
        const t = now / 1000;
        tx = 0.5 + 0.32 * Math.sin(t * 0.21);
        ty = 0.45 + 0.22 * Math.sin(t * 0.33 + 1);
      }
      x += (tx - x) * 0.07;
      y += (ty - y) * 0.07;
      place();
      if (now - lastPing > 650) {
        lastPing = now;
        ping();
      }
      raf = requestAnimationFrame(tick);
    };
    // Only while on screen.
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !running) {
        running = true;
        raf = requestAnimationFrame(tick);
      } else if (!e.isIntersecting && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    });
    io.observe(el);
    host.addEventListener("pointermove", onMove);
    return () => {
      ro.disconnect();
      io.disconnect();
      cancelAnimationFrame(raf);
      host.removeEventListener("pointermove", onMove);
    };
  }, [reduced]);

  const cellsOf = () =>
    CELLS.map((h, i) => (
      <span key={i} className="hf-cell">
        @{h}
      </span>
    ));
  return (
    <div ref={box} className="handle-field" aria-hidden="true">
      <div className="hf-grid hf-base">{cellsOf()}</div>
      <div ref={lens} className="hf-lens">
        <div ref={lit} className="hf-grid hf-lit">
          {cellsOf()}
        </div>
      </div>
    </div>
  );
}
