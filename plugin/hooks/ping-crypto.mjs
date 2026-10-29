// End-to-end encryption for Ping rooms.
//
// The room key never reaches the server. It lives in the fragment of the invite
// link (`.../g/gk_abc#k=<key>`), which browsers and HTTP clients never transmit,
// and on disk in ~/.ping/state.json. Everything a member writes is sealed here,
// on their own machine, before it goes anywhere.
//
// That puts the trust boundary exactly where the invite link already put it:
// anyone holding the full link can read the room, and nobody else can — not the
// server, not a database dump, not whoever runs theping.chat.
//
// AES-256-GCM from node:crypto rather than a library: the plugin has no
// dependencies and should keep it that way, and GCM authenticates as well as
// encrypts, so a tampered message fails to open instead of decoding to garbage.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// Marker, not magic bytes. A client without the key still shows something a
// person can act on instead of a wall of base64.
export const MARKER = "ping-e2e:v1:";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");

export function newRoomKey() {
  return b64u(randomBytes(32));
}

// A key is 32 bytes, base64url. Anything else is a typo or a truncated link,
// and must fail loudly rather than silently leaving the room in plaintext.
export function keyFrom(b64) {
  if (typeof b64 !== "string" || !b64) return null;
  let raw;
  try {
    raw = unb64u(b64);
  } catch {
    return null;
  }
  return raw.length === 32 ? raw : null;
}

// Pull the key out of an invite link's fragment. The fragment is the whole
// point: it is not sent to the server on any request.
export function keyFromLink(link) {
  const hash = String(link ?? "").split("#")[1];
  if (!hash) return null;
  const m = /(?:^|&)k=([A-Za-z0-9_-]+)/.exec(hash);
  return m ? m[1] : null;
}

export function linkWithKey(url, keyB64) {
  return keyB64 ? `${String(url).split("#")[0]}#k=${keyB64}` : String(url);
}

export function seal(text, key) {
  if (!key || typeof text !== "string" || !text) return text;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return MARKER + b64u(iv) + ":" + b64u(Buffer.concat([ct, c.getAuthTag()]));
}

// Returns the plaintext, or the input untouched when it is not ours to open.
// Pass-through is deliberate: a room can hold both encrypted messages from
// plugin members and plaintext ones from a webhook or a client without the key,
// and refusing to render the second kind would hide half the room.
export function open(payload, key) {
  if (typeof payload !== "string" || !payload.startsWith(MARKER)) return payload;
  if (!key) return payload;
  const [ivB64, bodyB64] = payload.slice(MARKER.length).split(":");
  if (!ivB64 || !bodyB64) return payload;
  try {
    const body = unb64u(bodyB64);
    if (body.length < 17) return payload; // tag alone is 16 bytes
    const d = createDecipheriv("aes-256-gcm", key, unb64u(ivB64));
    d.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext. Show the marker rather than inventing
    // plaintext — a silent empty string would read as "they said nothing".
    return payload;
  }
}

// Walk any JSON the server sent back and open every sealed string in it.
// Generic on purpose: the response shapes differ per tool and keep changing,
// and a per-field list would quietly stop covering new ones.
export function openDeep(value, key, depth = 0) {
  if (depth > 12) return value;
  if (typeof value === "string") return open(value, key);
  if (Array.isArray(value)) return value.map((v) => openDeep(v, key, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = openDeep(v, key, depth + 1);
    return out;
  }
  return value;
}

// The fields that carry what a person wrote. Everything else in a tool call is
// routing (ids, limits, states) and is no use to anyone reading the database.
const SECRET_FIELDS = new Set(["text", "title", "detail", "artifact", "result", "body", "name"]);

// `name` is a display name, not content, and the server needs it legible to
// attribute messages and match @mentions. Sealing it would break both.
const KEEP_CLEAR = new Set(["ping_join", "ping_create_group", "ping_card"]);

export function sealArgs(tool, args, key) {
  if (!key || !args || typeof args !== "object" || KEEP_CLEAR.has(tool)) return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = SECRET_FIELDS.has(k) && typeof v === "string" ? seal(v, key) : v;
  }
  return out;
}
