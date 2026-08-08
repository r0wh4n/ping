// Client-side E2E crypto for 1:1 DMs.
// - Identity = a Curve25519 box keypair per user.
// - The secret key is encrypted with a key derived from the login PASSWORD
//   (PBKDF2) and stored server-side, so any device with the password can
//   recover it. The server only ever sees ciphertext.
// - Messages use nacl.box (sender secret + recipient public) — authenticated
//   encryption with a per-message nonce.
import nacl from "tweetnacl";
import util from "tweetnacl-util";

const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = util;

export type Identity = { pub: Uint8Array; sec: Uint8Array };

const PBKDF2_ITERS = 200_000;

// ── password → 32-byte symmetric key (wraps the secret key) ──
export async function deriveKey(password: string, saltB64: string): Promise<Uint8Array> {
  // Copy into fresh ArrayBuffer-backed arrays to satisfy crypto.subtle's BufferSource typing.
  const salt = new Uint8Array(decodeBase64(saltB64));
  const pw = new Uint8Array(new TextEncoder().encode(password));
  const base = await crypto.subtle.importKey("raw", pw, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    base,
    256
  );
  return new Uint8Array(bits);
}

export const newSaltB64 = () => encodeBase64(nacl.randomBytes(16));
export const newKeyPair = (): Identity => {
  const kp = nacl.box.keyPair();
  return { pub: kp.publicKey, sec: kp.secretKey };
};
export const pubFromSecret = (sec: Uint8Array) => nacl.box.keyPair.fromSecretKey(sec).publicKey;

// ── secretbox: wrap/unwrap the secret key with the password-derived key ──
export function sealSecret(secretKey: Uint8Array, symKey: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(secretKey, nonce, symKey);
  return `${encodeBase64(nonce)}:${encodeBase64(box)}`;
}
export function openSecret(payload: string, symKey: Uint8Array): Uint8Array | null {
  const [n, b] = payload.split(":");
  if (!n || !b) return null;
  return nacl.secretbox.open(decodeBase64(b), decodeBase64(n), symKey);
}

// ── box: encrypt/decrypt a 1:1 message body ──
export function encryptFor(text: string, theirPubB64: string, mySecret: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(decodeUTF8(text), nonce, decodeBase64(theirPubB64), mySecret);
  return `${encodeBase64(nonce)}:${encodeBase64(box)}`;
}
export function decryptFrom(payload: string, theirPubB64: string, mySecret: Uint8Array): string | null {
  const [n, b] = payload.split(":");
  if (!n || !b) return null;
  const open = nacl.box.open(decodeBase64(b), decodeBase64(n), decodeBase64(theirPubB64), mySecret);
  return open ? encodeUTF8(open) : null;
}

export const toB64 = encodeBase64;
export const fromB64 = decodeBase64;

// ── ephemeral session key for "Live" (zero-trace) chats ──
// Both sides exchange fresh ephemeral public keys and derive the same shared
// key; it lives only in memory for the session and is discarded on exit.
export const sharedKey = (theirEphPubB64: string, myEphSec: Uint8Array): Uint8Array =>
  nacl.box.before(decodeBase64(theirEphPubB64), myEphSec);

export function sealLive(text: string, shared: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  return `${encodeBase64(nonce)}:${encodeBase64(nacl.box.after(decodeUTF8(text), nonce, shared))}`;
}
export function openLive(payload: string, shared: Uint8Array): string | null {
  const [n, b] = payload.split(":");
  if (!n || !b) return null;
  const open = nacl.box.open.after(decodeBase64(b), decodeBase64(n), shared);
  return open ? encodeUTF8(open) : null;
}

// ── in-memory identity singleton + localStorage cache (per user) ──
let current: Identity | null = null;
const cacheKey = (uid: string) => `ping_id_${uid}`;

export function setIdentity(id: Identity | null) {
  current = id;
}
export function getIdentity(): Identity | null {
  return current;
}
export function cacheIdentity(uid: string, id: Identity) {
  current = id;
  try {
    localStorage.setItem(cacheKey(uid), JSON.stringify({ pub: encodeBase64(id.pub), sec: encodeBase64(id.sec) }));
  } catch {
    /* storage blocked */
  }
}
export function loadCachedIdentity(uid: string): Identity | null {
  try {
    const raw = localStorage.getItem(cacheKey(uid));
    if (!raw) return null;
    const { pub, sec } = JSON.parse(raw);
    current = { pub: decodeBase64(pub), sec: decodeBase64(sec) };
    return current;
  } catch {
    return null;
  }
}
export function clearIdentity(uid?: string) {
  current = null;
  try {
    if (uid) localStorage.removeItem(cacheKey(uid));
  } catch {
    /* ignore */
  }
}
