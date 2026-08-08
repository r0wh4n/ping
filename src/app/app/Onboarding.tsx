"use client";

import { useState } from "react";

type PushState = "unsupported" | "off" | "on" | "denied" | "busy";

export default function Onboarding({
  username,
  link,
  pushState,
  onEnablePush,
  onDone,
}: {
  username: string;
  link: string;
  pushState: PushState;
  onEnablePush: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const steps = [
    {
      label: "WELCOME",
      title: (
        <>
          Hey <span className="gradient-text">@{username}</span> 👋
        </>
      ),
      body: "Ping is friends-only. No feeds, no strangers, no noise — just the people you actually talk to.",
      content: null,
    },
    {
      label: "GROW YOUR CIRCLE",
      title: <>Add your people</>,
      body: "Add anyone by their @handle, or share your link and let friends add you in one tap.",
      content: (
        <div className="mt-5">
          <div className="mono truncate rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 py-2.5 text-sm text-muted">
            {link || "…"}
          </div>
          <button onClick={copy} className="btn-ghost mt-3 w-full justify-center py-2.5 text-sm">
            {copied ? "Copied ✓" : "Copy my link"}
          </button>
        </div>
      ),
    },
    {
      label: "STAY IN THE LOOP",
      title: <>Never miss a ping</>,
      body: "Turn on notifications so you know the moment a friend messages you.",
      content: (
        <div className="mt-5">
          {pushState === "on" ? (
            <p className="text-sm text-[color:var(--ok)]">✓ Notifications are on.</p>
          ) : pushState === "unsupported" ? (
            <p className="text-sm text-muted">
              On iPhone: <span className="text-text">Share → Add to Home Screen</span>, then open Ping and enable.
            </p>
          ) : pushState === "denied" ? (
            <p className="text-sm text-muted">Blocked in your browser — turn it on in site settings later.</p>
          ) : (
            <button
              onClick={onEnablePush}
              disabled={pushState === "busy"}
              className="btn w-full justify-center py-2.5 text-sm disabled:opacity-50"
            >
              {pushState === "busy" ? "…" : "🔔 Enable notifications"}
            </button>
          )}
        </div>
      ),
    },
  ];

  const s = steps[step];
  const last = step === steps.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm">
      <div className="idcard w-full max-w-md">
        <div className="flex items-center justify-between">
          <p className="label">{s.label}</p>
          <button onClick={onDone} className="text-xs text-muted transition hover:text-text">
            Skip
          </button>
        </div>
        <h2 className="mt-4 text-2xl font-semibold tracking-tight">{s.title}</h2>
        <p className="mt-3 text-sm text-muted">{s.body}</p>
        {s.content}

        <div className="mt-7 flex items-center justify-between">
          <div className="flex gap-1.5">
            {steps.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-1.5 rounded-full ${i === step ? "bg-[color:var(--text)]" : "bg-[color:var(--border-strong)]"}`}
              />
            ))}
          </div>
          <button
            onClick={() => (last ? onDone() : setStep((n) => n + 1))}
            className="btn px-5 py-2.5 text-sm"
          >
            {last ? "Start pinging →" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
