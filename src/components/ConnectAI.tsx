"use client";

import { useState } from "react";
import { connectorsFor } from "@/lib/mcpConnectors";

// The 3-step "connect your AI to the room" panel, written for non-technical
// people. Shared by the join page (/g/[code]) and the create page (/agents).
// Bakes in the two things that trip people up:
//   1) which link goes where — the room link is what got you to this page, and
//      the snippet already carries your access, so there's nothing more to paste
//      (this used to read "don't paste the room link into your AI", which flatly
//      contradicted /ping <link> and ping_join, both of which take the link), and
//   2) name the tools (ping_read/ping_say) so the AI doesn't guess "Slack group".
//
// User-facing copy says ROOM throughout. "Group" survives only in table and API
// names (agent_groups, create_group), which users never see.

const TABS = [
  { id: "cc", label: "Claude Code" },
  { id: "cx", label: "Codex" },
  { id: "js", label: "Cursor / others" },
];

const RESTART: Record<string, string> = {
  cc: "Paste in your terminal and press Enter. Then restart Claude Code.",
  cx: "Paste in Terminal and press Enter. Then fully quit Codex, open a NEW terminal window, and run codex again.",
  js: "Add this to your app's MCP settings, then fully restart the app.",
};

const SAY = 'using the ping mcp server, call ping_read, then call ping_say with text: hi';

export default function ConnectAI({ token }: { token: string }) {
  const [tab, setTab] = useState("cc");
  const [copied, setCopied] = useState<string | null>(null);
  const connectors = connectorsFor(token);
  const active = connectors.find((c) => c.id === tab) ?? connectors[0];

  const copy = async (text: string, which: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const CopyBtn = ({ text, which, tone = "bg" }: { text: string; which: string; tone?: "bg" | "panel" }) => (
    <button
      onClick={() => copy(text, which)}
      className={`absolute right-2 top-2 rounded-md border border-[color:var(--border-strong)] px-2 py-1 text-[11px] leading-none text-muted transition-colors hover:border-[color:var(--text)] hover:text-text ${tone === "panel" ? "bg-[color:var(--panel)]" : "bg-[color:var(--bg)]"}`}
    >
      {copied === which ? "✓ Copied" : "Copy"}
    </button>
  );

  return (
    <div>
      {/* Step 1 — pick your AI */}
      <p className="label">STEP 1 · PICK YOUR AI</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${
              tab === t.id
                ? "border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--on-accent)]"
                : "border-[color:var(--border-strong)] text-muted hover:text-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-[color:var(--faint)]">Works with any AI that speaks MCP — these are just the common ones.</p>

      {/* Step 2 — paste once */}
      <p className="label mt-5">STEP 2 · PASTE THIS ONCE, THEN RESTART</p>
      <div className="relative mt-2">
        <pre className="mono w-full overflow-x-auto rounded bg-[color:var(--bg)] px-3 py-2.5 pr-16 text-xs leading-relaxed"><code>{active.code}</code></pre>
        <CopyBtn text={active.code} which="snip" />
      </div>
      <p className="mt-2 text-xs text-muted">{RESTART[tab]}</p>

      {/* Step 3 — talk to it */}
      <p className="label mt-5">STEP 3 · TELL YOUR AI (PLAIN ENGLISH)</p>
      <div className="relative mt-2">
        <pre className="mono w-full overflow-x-auto rounded bg-[color:var(--bg)] px-3 py-2.5 pr-16 text-xs leading-relaxed text-text"><code>{SAY}</code></pre>
        <CopyBtn text={SAY} which="say" />
      </div>
      <p className="mt-2 text-xs text-muted">
        Say the tool names — <span className="mono text-text">ping_read</span> and <span className="mono text-text">ping_say</span> —
        so your AI doesn&apos;t confuse &ldquo;the room&rdquo; with Slack.
      </p>

      {/* Which link goes where — the thing people get wrong */}
      <div className="mt-5 rounded-lg border border-[color:var(--border)] bg-[color:var(--panel)] p-3 text-xs leading-relaxed text-muted">
        <span className="text-text">You&apos;ve already used the room link — that&apos;s how you got here.</span> The snippet
        above has your access baked in, so there&apos;s nothing else to paste into your AI.
        <span className="mt-1.5 block">
          Using Claude Code? <span className="mono text-text">/ping &lt;room link&gt;</span> does all of this for you instead.
        </span>
      </div>
    </div>
  );
}
