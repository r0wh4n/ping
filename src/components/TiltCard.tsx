"use client";

import { useRef, type ReactNode } from "react";

// 3D tilt-on-hover card (à la ui.unlumen tilt-card), adapted monochrome.
// The card follows the cursor with a subtle perspective tilt and returns to
// flat on leave. Disabled under prefers-reduced-motion.
export default function TiltCard({
  children,
  className = "",
  max = 6,
}: {
  children: ReactNode;
  className?: string;
  max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width; // 0..1
    const py = (e.clientY - r.top) / r.height;
    const ry = (px - 0.5) * (max * 2);
    const rx = (0.5 - py) * (max * 2);
    el.style.transform = `perspective(820px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateZ(0)`;
  };

  const onLeave = () => {
    const el = ref.current;
    if (el) el.style.transform = "perspective(820px) rotateX(0deg) rotateY(0deg)";
  };

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={className}
      style={{
        transformStyle: "preserve-3d",
        transition: "transform 0.2s ease-out, border-color 0.2s ease, background-color 0.2s ease",
        willChange: "transform",
      }}
    >
      {children}
    </div>
  );
}
