"use client";

import { useState } from "react";

type Friend = { id: string; username: string };

export default function NewGroup({
  friends,
  onCreate,
  onClose,
}: {
  friends: Friend[];
  onCreate: (name: string, ids: string[]) => Promise<{ ok: boolean; id?: string }>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const submit = async () => {
    if (busy || !name.trim() || sel.size === 0) return;
    setBusy(true);
    setErr(null);
    const res = await onCreate(name.trim(), [...sel]);
    setBusy(false);
    if (!res.ok) setErr("Couldn't create the group. Try again.");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="idcard w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <p className="label">NEW GROUP</p>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={50}
          placeholder="Group name"
          className="mt-4 w-full rounded-lg border border-[color:var(--border-strong)] bg-[color:var(--bg)] px-3 py-2.5 text-[15px] outline-none placeholder:text-[color:var(--faint)] focus:border-[color:var(--focus)]"
        />

        <p className="label mt-5">ADD FRIENDS</p>
        {friends.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            Add some friends first — you can only add friends to a group.
          </p>
        ) : (
          <div className="mt-3 flex max-h-56 flex-col divide-y divide-[color:var(--border)] overflow-y-auto">
            {friends.map((f) => (
              <label key={f.id} className="flex cursor-pointer items-center justify-between py-2.5">
                <span className="mono text-sm">@{f.username}</span>
                <input
                  type="checkbox"
                  checked={sel.has(f.id)}
                  onChange={() => toggle(f.id)}
                  className="h-4 w-4 accent-white"
                />
              </label>
            ))}
          </div>
        )}

        {err && <p className="mt-2 text-sm text-[color:var(--danger)]">{err}</p>}

        <div className="mt-5 flex gap-2">
          <button
            onClick={submit}
            disabled={busy || !name.trim() || sel.size === 0}
            className="btn justify-center px-4 py-2.5 text-sm disabled:opacity-40"
          >
            {busy ? "…" : `Create group${sel.size ? ` (${sel.size})` : ""}`}
          </button>
          <button onClick={onClose} className="btn-ghost px-4 py-2.5 text-sm">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
