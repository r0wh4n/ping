// Webhook signature primitives.
//
// Written with JSDoc types rather than TypeScript annotations on purpose: the
// file is then valid JavaScript as well as valid TypeScript, so the Deno edge
// function and the Node self-check in scripts/check-webhook-signature.mjs load
// the exact same bytes. A MAC comparison that is only tested by a reimplementation
// of itself is not tested.

/** @param {Uint8Array} b */
export const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Length-independent, data-independent compare. Never use === on a MAC:
 * a short-circuiting compare leaks how many leading characters were right,
 * which is enough to recover a signature byte by byte.
 * @param {string} a @param {string} b
 */
export function sameSecret(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Hex HMAC-SHA256 over the raw body, which is what GitHub and Linear both sign.
 * @param {string} secret @param {string} raw @returns {Promise<string>}
 */
export async function hmacHex(secret, raw) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw))));
}

/**
 * Did this request carry a signature we can verify?
 *   "good"   — present and matched
 *   "bad"    — present and did not match
 *   "absent" — the sender did not sign at all
 * GitHub sends sha256=<hex>; Linear and the generic header send bare hex.
 * @param {{ get(name: string): string | null }} headers
 * @param {string} raw @param {string} secret
 * @returns {Promise<"good"|"bad"|"absent">}
 */
export async function checkSignature(headers, raw, secret) {
  const given = (
    headers.get("x-hub-signature-256") ||   // GitHub
    headers.get("linear-signature") ||      // Linear
    headers.get("x-ping-signature") ||      // anything else
    ""
  ).trim().toLowerCase();
  if (!given) return "absent";
  const sig = given.startsWith("sha256=") ? given.slice(7) : given;
  // Shape-check first so a malformed header is "bad" rather than an exception.
  if (!/^[0-9a-f]{64}$/.test(sig)) return "bad";
  return sameSecret(sig, await hmacHex(secret, raw)) ? "good" : "bad";
}
