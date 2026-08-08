"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// Lightweight, dependency-free take on Magic UI's Terminal. Lines reveal in
// sequence (by their `delay`) once the terminal scrolls into view; TypingAnimation
// types a string out char-by-char. Honors prefers-reduced-motion (shows all at once).

const TerminalCtx = createContext<{ started: boolean; reduced: boolean }>({ started: false, reduced: false });

const prefersReduced = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function Terminal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(false);
  const reduced = prefersReduced();

  useEffect(() => {
    if (reduced) {
      setStarted(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setStarted(true);
          io.disconnect();
        }
      },
      { threshold: 0.35 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduced]);

  return (
    <TerminalCtx.Provider value={{ started, reduced }}>
      <div ref={ref} className={`mono ${className}`}>
        {children}
      </div>
    </TerminalCtx.Provider>
  );
}

export function AnimatedSpan({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const { started, reduced } = useContext(TerminalCtx);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!started) return;
    if (reduced) {
      setShown(true);
      return;
    }
    const t = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(t);
  }, [started, reduced, delay]);

  return (
    <div
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? "translateY(0)" : "translateY(4px)",
        transition: "opacity 0.35s ease, transform 0.35s ease",
      }}
    >
      {children}
    </div>
  );
}

export function TypingAnimation({
  children,
  delay = 0,
  duration = 35,
  className = "",
}: {
  children: string;
  delay?: number;
  duration?: number;
  className?: string;
}) {
  const { started, reduced } = useContext(TerminalCtx);
  const full = typeof children === "string" ? children : "";
  const [text, setText] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!started) return;
    if (reduced) {
      setText(full);
      setDone(true);
      return;
    }
    let i = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const startT = setTimeout(() => {
      interval = setInterval(() => {
        i++;
        setText(full.slice(0, i));
        if (i >= full.length) {
          if (interval) clearInterval(interval);
          setDone(true);
        }
      }, duration);
    }, delay);
    return () => {
      clearTimeout(startT);
      if (interval) clearInterval(interval);
    };
  }, [started, reduced, delay, duration, full]);

  return (
    <div className={className} style={{ opacity: started ? 1 : 0 }}>
      {text}
      {!done && started && <span className="ml-0.5 inline-block animate-pulse">▋</span>}
    </div>
  );
}
