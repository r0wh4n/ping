"use client";

import { useRef } from "react";

// The light that follows the pointer across .spot-card borders, as in the home
// page's feature grid.
export default function SpotGrid({ className = "", children }: { className?: string; children: React.ReactNode }) {
  const grid = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent) => {
    grid.current?.querySelectorAll<HTMLElement>(".spot-card").forEach((c) => {
      const r = c.getBoundingClientRect();
      c.style.setProperty("--mx", `${e.clientX - r.left}px`);
      c.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  };
  return (
    <div ref={grid} onPointerMove={move} className={`spot-grid ${className}`}>
      {children}
    </div>
  );
}
