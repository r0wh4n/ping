"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getSaved, removeSaved, type SavedItem } from "@/lib/saved";
import { fmtTime } from "@/lib/time";
import Markdown from "@/components/Markdown";

export default function SavedPage() {
  const [items, setItems] = useState<SavedItem[]>([]);

  useEffect(() => {
    setItems(getSaved());
  }, []);

  const unsave = (id: string) => {
    removeSaved(id);
    setItems(getSaved());
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col">
      <nav className="flex items-center justify-between border-b border-border px-4 py-4">
        <Link href="/app" className="label transition hover:text-text">&larr; Back</Link>
        <span className="mono text-sm font-semibold">Saved messages</span>
        <span className="w-12" />
      </nav>

      <section className="flex-1 px-4 py-6">
        {items.length === 0 ? (
          <div className="mt-16 text-center">
            <p className="mono text-lg">No saved messages yet.</p>
            <p className="mt-2 text-sm text-muted">
              Tap a message in any chat → <span className="text-text">Save</span> to keep it here.
            </p>
            <p className="mt-4 text-xs text-[color:var(--faint)]">
              Saved messages stay on this device only — never re-uploaded.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((s) => (
              <li key={s.id} className="card p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="label">{s.from} · {fmtTime(new Date(s.savedAt).toISOString())}</span>
                  <button
                    onClick={() => unsave(s.id)}
                    className="rounded-md px-2 py-1 text-xs text-[color:var(--faint)] transition hover:text-[color:var(--danger)]"
                    title="Remove from saved"
                  >
                    ✕
                  </button>
                </div>
                <div className="mt-2 break-words text-[15px] leading-snug">
                  <Markdown text={s.text} />
                </div>
                {s.handle && (
                  <Link href={`/app/dm/${s.handle}`} className="mt-3 inline-block text-xs text-muted underline transition hover:text-text">
                    Open chat with @{s.handle} →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-8 text-center text-xs text-[color:var(--faint)]">
          {items.length > 0 && `${items.length} saved · `}Stored locally on this device for privacy.
        </p>
      </section>
    </main>
  );
}
