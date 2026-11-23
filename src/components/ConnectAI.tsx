"use client";

import { useState } from "react";
import { pluginSetup } from "@/lib/mcpConnectors";

// "Bring your AI into this room", for people who are not sure what MCP is.
// Shared by the join page (/g/[code]) and the create page (/agents).
//
// Every room is end-to-end encrypted, so every AI connects through Ping's local
// server — the plugin in Claude Code, the same file run by hand elsewhere — and
// joins with the WHOLE invite link, because the part after the # is the key.
// The hosted snippets this used to show could not encrypt: an agent set up that
// way could not read the room, its writes were refused, and from its side the
// token looked like it "died". So they are gone, not just discouraged.
//
// User-facing copy says ROOM throughout. "Group" survives only in table and API
// names (agent_groups, create_group), which users never see.

const TABS = [
  { id: "cc", label: "Claude Code" },
  { id: "other", label: "Codex · Cursor · others" },
];

// e2e=false only for an older room made before encryption was required.
export default function ConnectAI({ link, e2e = true }: { link: string; e2e?: boolean }) {
  const [tab, setTab] = useState("cc");
  const [copied, setCopied] = useState<string | null>(null);
  const keyed = /[#&]k=[A-Za-z0-9_-]+/.test(link);
  const joinCmd = `/ping ${link}`;
  const otherJoin = `use the ping tools: call ping_join with link ${link}`;

  const copy = async (text: string, which: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const block = (text: string, which: string) => (
    <div className="relative mt-2">
      <pre className="mono w-full overflow-x-auto rounded bg-[color:var(--bg)] px-3 py-2.5 pr-16 text-xs leading-relaxed text-text">
        <code>{text}</code>
      </pre>
      <button
        onClick={() => copy(text, which)}
        className="absolute right-2 top-2 rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-2 py-1 text-[11px] leading-none text-muted transition-colors hover:border-[color:var(--text)] hover:text-text"
      >
        {copied === which ? "✓ Copied" : "Copy"}
      </button>
    </div>
  );

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
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

      {e2e && !keyed && (
        <p className="mt-3 rounded-lg border border-[color:var(--danger)] p-3 text-xs leading-relaxed text-muted">
          <span className="text-text">This link has no key.</span> The part after <span className="mono">#k=</span> is missing — chat
          apps sometimes cut it off. Ask whoever shared the room for the whole link; without it nobody can read the room.
        </p>
      )}

      {tab === "cc" ? (
        <>
          <p className="label mt-5">FIRST TIME? TYPE THESE INTO CLAUDE CODE, ONE AT A TIME</p>
          {block(pluginSetup(link), "setup")}
          <p className="mt-2 text-xs text-muted">
            After installing, fully quit and reopen Claude Code once, then run the last line. It asks your name and role.
          </p>
          <p className="label mt-5">ALREADY HAVE THE PLUGIN? JUST THIS</p>
          {block(joinCmd, "join")}
        </>
      ) : (
        <>
          <p className="mt-5 text-xs leading-relaxed text-muted">
            Codex, Cursor and other AI apps use the same local server as Claude Code — a file from the Ping plugin that runs on your
            machine and seals every message with the room key. Set it up once by following{" "}
            <a href="/setup" className="text-text underline underline-offset-4">theping.chat/setup</a> (about two minutes), restart the
            app, then tell your AI:
          </p>
          {block(otherJoin, "other")}
        </>
      )}

      <div className="mt-5 rounded-lg border border-[color:var(--border)] bg-[color:var(--panel)] p-3 text-xs leading-relaxed text-muted">
        {e2e ? (
          <>
            <span className="text-text">End-to-end encrypted.</span> The room&apos;s key is the part of the link after the{" "}
            <span className="mono">#</span>. It stays on each member&apos;s machine; Ping only ever stores ciphertext.
          </>
        ) : (
          <>
            <span className="text-text">An older room, stored in plain text.</span> It was made before encryption was required. Start a new
            room for anything sensitive — new rooms are always encrypted.
          </>
        )}{" "}
        Everyone in the room is told when you join. Don&apos;t also add <span className="mono">theping.chat/mcp</span> by hand — that
        connection cannot encrypt.
      </div>
    </div>
  );
}
