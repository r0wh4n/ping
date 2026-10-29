// Reading end-to-end encrypted agent rooms in the browser.
//
// The envelope is the one the plugin writes (plugin/hooks/ping-crypto.mjs):
// `ping-e2e:v1:<iv>:<ciphertext||tag>`, AES-256-GCM, base64url. Node appends the
// 16-byte tag to the ciphertext and WebCrypto expects it appended, so the two
// interoperate without either side reshaping anything.
//
// Keys are held per room in localStorage, never sent anywhere. Mission Control
// shows many rooms at once, so a single URL fragment cannot serve them all — a
// room's key is captured when you open its invite link and kept for next time.

export const MARKER = "ping-e2e:v1:";

const STORE = "ping.roomKeys";

function unb64u(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type KeyMap = Record<string, string>;

// Every read and write is guarded: localStorage throws in a private window and
// comes back empty when site data is cleared, and neither should break the page.
function readMap(): KeyMap {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as KeyMap) : {};
  } catch {
    return {};
  }
}

export function getRoomKey(groupId: string): string | null {
  return readMap()[groupId] ?? null;
}

export function setRoomKey(groupId: string, keyB64: string): void {
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...readMap(), [groupId]: keyB64 }));
  } catch {
    /* private window — the room just stays locked this session */
  }
}

// A key is 32 bytes, base64url. Anything else is a truncated or mistyped link
// and must be refused rather than stored and silently failing to open anything.
export async function importRoomKey(keyB64: string | null): Promise<CryptoKey | null> {
  if (!keyB64) return null;
  try {
    const raw = unb64u(keyB64);
    if (raw.length !== 32) return null;
    return await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["decrypt"]);
  } catch {
    return null;
  }
}

export function isSealed(text: string): boolean {
  return typeof text === "string" && text.startsWith(MARKER);
}

// Returns the plaintext, or the input untouched when it is not ours to open.
// A room mixes sealed messages from plugin members with plaintext from webhooks
// and from clients holding only the hosted URL; both have to render.
export async function openText(payload: string, key: CryptoKey | null): Promise<string> {
  if (!isSealed(payload) || !key) return payload;
  const [ivB64, bodyB64] = payload.slice(MARKER.length).split(":");
  if (!ivB64 || !bodyB64) return payload;
  try {
    const body = unb64u(bodyB64);
    if (body.length < 17) return payload; // the tag alone is 16 bytes
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64u(ivB64) as BufferSource },
      key,
      body as BufferSource
    );
    return new TextDecoder().decode(out);
  } catch {
    // Wrong key, or tampered. Show the envelope rather than inventing plaintext:
    // an empty string would read as "they said nothing".
    return payload;
  }
}

export async function openAll<T extends { text: string; title?: string | null }>(
  rows: T[],
  key: CryptoKey | null
): Promise<T[]> {
  if (!key) return rows;
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      text: await openText(r.text, key),
      ...(r.title ? { title: await openText(r.title, key) } : {}),
    }))
  );
}

// The key travels in the invite link's fragment, which is never sent to a
// server. Read it off the current URL, if this page was opened with one.
export function keyFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const m = /(?:^|[#&])k=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  return m ? m[1] : null;
}

// Accepts a bare key or a whole invite link pasted into the unlock box, because
// people will paste whichever they have to hand.
export function keyFromInput(input: string): string | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  const m = /(?:^|[#&])k=([A-Za-z0-9_-]+)/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{43,44}$/.test(s) ? s : null;
}
