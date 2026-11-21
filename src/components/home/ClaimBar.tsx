"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useReducedMotion } from "@/hooks/useReducedMotion";

const NAMES = ["maya", "rohan", "zara", "neo", "you"];

// The claim box: handles type themselves in after theping.chat/@, the way you
// would. It is an input, so it is the one place on the page that types.
export default function ClaimBar({ className = "" }: { className?: string }) {
  const reduced = useReducedMotion();
  const [text, setText] = useState("");

  useEffect(() => {
    if (reduced) return;
    let word = 0;
    let n = 0;
    let dir = 1;
    let hold = 0;
    const id = setInterval(() => {
      if (hold > 0) {
        hold -= 1;
        return;
      }
      const w = NAMES[word];
      n += dir;
      if (n > w.length) {
        dir = -1;
        n = w.length;
        hold = 18; // read it
        return;
      }
      if (n < 0) {
        dir = 1;
        n = 0;
        word = (word + 1) % NAMES.length;
        hold = 3;
        return;
      }
      setText(w.slice(0, n));
    }, 80);
    return () => clearInterval(id);
  }, [reduced]);

  return (
    <Link href="/app" aria-label="Claim your @handle" className={`claim-bar ${className}`}>
      <span className="mono min-w-0 truncate text-[14.5px] sm:text-base" aria-hidden="true">
        <span className="text-[color:var(--faint)]">theping.chat/</span>
        <span className="text-text">@{reduced ? "you" : text}</span>
        <span className="claim-caret" />
      </span>
      <span className="btn shrink-0 px-4 py-2.5 text-[13px] sm:px-5 sm:text-sm">Claim it →</span>
    </Link>
  );
}
