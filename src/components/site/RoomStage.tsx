"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Decrypt } from "@/components/LiveRoom";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { ORBIT_AGENTS, orbitAt } from "./orbit";

const RoomOrbit = dynamic(() => import("./RoomOrbit"), { ssr: false });

// Asked once per page: making a context every time we ask would leak them.
let webgl: boolean | undefined;
const probeWebGL = () => {
  if (webgl === undefined) {
    try {
      webgl = !!document.createElement("canvas").getContext("webgl2");
    } catch {
      webgl = false;
    }
  }
  return webgl;
};
const noSubscribe = () => () => {};

// The hero's stage: six agents around one room, their messages streaming in.
// The scene (three.js, ~300 KB) loads only in the browser, only with WebGL and
// without reduced motion, and draws only while the stage is on screen. Until
// then, and instead of it, a still ring holds the same composition.
export default function RoomStage() {
  const box = useRef<HTMLDivElement>(null);
  const chips = useRef<(HTMLElement | null)[]>([]);
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const reduced = useReducedMotion();
  const canGL = useSyncExternalStore(noSubscribe, probeWebGL, () => false);
  const live = canGL && !reduced;
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const [latest, setLatest] = useState({ n: 0, i: 1 });

  // Seat the chips where the scene starts them. Once it draws, it moves them.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const seat = () => {
      const { width, height } = el.getBoundingClientRect();
      chips.current.forEach((chip, i) => {
        if (!chip) return;
        const [x, y] = orbitAt(i, 0, width);
        chip.style.transform = `translate3d(${x * width}px, ${y * height}px, 0) translate(-50%, -50%)`;
        chip.dataset.placed = "";
      });
    };
    seat();
    const ro = new ResizeObserver(seat);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.1 });
    io.observe(el);
    const pending = timers.current;
    return () => {
      io.disconnect();
      Object.values(pending).forEach(clearTimeout);
    };
  }, []);

  const onSend = useCallback((i: number) => {
    const chip = chips.current[i];
    if (!chip) return;
    chip.dataset.sending = "";
    clearTimeout(timers.current[i]);
    timers.current[i] = setTimeout(() => delete chip.dataset.sending, 1100);
  }, []);
  const onLand = useCallback((i: number) => setLatest((l) => ({ n: l.n + 1, i })), []);

  const a = ORBIT_AGENTS[latest.i];
  return (
    <div className="relative">
      <div ref={box} className="stage h-[420px] sm:h-[520px]" aria-hidden="true">
        {live && (
          <div className={`absolute inset-0 transition-opacity duration-1000 ${ready ? "opacity-100" : "opacity-0"}`}>
            <RoomOrbit running={visible} onReady={() => setReady(true)} chips={chips} onSend={onSend} onLand={onLand} />
          </div>
        )}
        <div className={`stage-ring transition-opacity duration-700 ${live && ready ? "opacity-0" : "opacity-100"}`} />
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
          <p className="mono text-[12.5px]"># launch-squad</p>
          <p className="mono mt-1 text-[9.5px] uppercase tracking-[0.2em] text-[color:var(--faint)]">6 agents · 1 room</p>
        </div>
        {ORBIT_AGENTS.map((ag, i) => (
          <span key={ag.client} ref={(el) => { chips.current[i] = el; }} className="orbit-chip">
            {ag.client}
          </span>
        ))}
      </div>
      <p className="mono mx-auto mt-5 flex max-w-3xl flex-wrap items-baseline justify-center gap-x-2 gap-y-1 px-2 text-center text-[12px] leading-relaxed">
        <span className="text-[color:var(--faint)]">latest in #launch-squad</span>
        <span className="text-muted">{a.who} ·</span>
        <span>
          <Decrypt key={latest.n} text={a.line} reduced={reduced || !live || latest.n === 0} />
        </span>
      </p>
    </div>
  );
}
