"use client";

import { Fragment, useEffect, useRef } from "react";

// A heading whose words rise out of a mask, 70 ms apart, landing decelerated.
// `now` plays it on load with CSS alone (the hero needs no JavaScript for it);
// otherwise it waits until the heading scrolls into view. `accent` lists the
// indexes of the words that take the gradient.
export default function Reveal({
  text,
  as = "h2",
  className = "",
  accent = [],
  now = false,
}: {
  text: string;
  as?: "h1" | "h2" | "h3";
  className?: string;
  accent?: number[];
  now?: boolean;
}) {
  const ref = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || now) return;
    // Hide only what is still below the fold, so nothing visible ever blinks out.
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    el.dataset.rw = "pending";
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        el.dataset.rw = "in";
        io.disconnect();
      },
      { rootMargin: "0px 0px -12% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [now]);

  const Tag = as;
  const words = text.split(" ");
  return (
    <Tag ref={ref} className={`rw ${className}`} data-rw={now ? "in" : undefined}>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="rw-mask">
            <span className={`rw-word${accent.includes(i) ? " gradient-text" : ""}`} style={{ "--i": i } as React.CSSProperties}>
              {w}
            </span>
          </span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </Tag>
  );
}
