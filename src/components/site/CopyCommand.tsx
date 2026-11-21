"use client";

import { useState } from "react";

// A command coloured by part, with a copy button. A part is [text, kind]:
// "cmd" the program, "arg" what it is asked to do, "val" what you fill in.
// `join` marks one command broken over lines: only its first line gets a prompt.
export type Part = [string, "cmd" | "arg" | "val" | "plain"];

export default function CopyCommand({ lines, prompt = "$", join = false, className = "" }: { lines: Part[][]; prompt?: string; join?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  const text = lines.map((l) => l.map(([t]) => t).join("")).join("\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the text is still there to select */
    }
  };
  return (
    <div className={`relative rounded-[var(--r-sm)] border border-border bg-[color:var(--bg)] ${className}`}>
      <pre className="mono overflow-x-auto px-4 py-3 pr-24 text-[12.5px] leading-relaxed">
        {lines.map((l, i) => (
          <div key={i}>
            <span className="select-none text-[color:var(--faint)]">{join && i > 0 ? "  " : `${prompt} `}</span>
            {l.map(([t, k], j) => (
              <span key={j} className={k === "plain" ? "text-text" : `tok-${k}`}>
                {t}
              </span>
            ))}
          </div>
        ))}
      </pre>
      {/* a long line fades out under the button instead of running beneath it */}
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-start rounded-r-[var(--r-sm)] bg-[linear-gradient(to_left,var(--bg)_62%,transparent)] pl-10 pr-2 pt-2">
        <button
          type="button"
          onClick={copy}
          className="pointer-events-auto rounded-full border border-border bg-[color:var(--panel)] px-2.5 py-1 text-[11px] text-muted transition hover:text-text"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
