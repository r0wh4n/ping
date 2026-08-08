// Saved / starred messages — stored DEVICE-LOCALLY on purpose. DM bodies are
// end-to-end encrypted; the message is already decrypted on screen when you save
// it, so we keep the plaintext only in this browser (never sent back to the
// server). Trade-off: saves don't sync across devices (a future e2e-synced
// enhancement), but nothing readable ever leaves the device.

export type SavedItem = {
  id: string;
  text: string;
  from: string; // "you" or "@handle"
  handle: string; // the DM partner, for the "open chat" link
  savedAt: number;
};

const KEY = "ping.saved";

export function getSaved(): SavedItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(list: SavedItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 500)));
  } catch {
    /* storage full / blocked */
  }
}

export function isSaved(id: string): boolean {
  return getSaved().some((s) => s.id === id);
}

/** Toggle a message's saved state. Returns true if now saved, false if removed. */
export function toggleSave(item: SavedItem): boolean {
  const list = getSaved();
  const i = list.findIndex((s) => s.id === item.id);
  if (i >= 0) {
    list.splice(i, 1);
    write(list);
    return false;
  }
  list.unshift(item);
  write(list);
  return true;
}

export function removeSaved(id: string) {
  write(getSaved().filter((s) => s.id !== id));
}
