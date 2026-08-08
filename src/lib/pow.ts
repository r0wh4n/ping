// Invisible proof-of-work signup gate (no third party, no keys, no tracking).
// The client must find a nonce so SHA-512("<username>:<bucket>:<nonce>") begins
// with POW_ZEROS zero hex digits. Binding to `bucket` (a 5-min time window) and
// the username stops precompute-far-ahead and cross-account reuse. The server
// re-checks a single hash and that the bucket is fresh.
import nacl from "tweetnacl";

export const POW_ZEROS = 4; // leading hex zeros of the SHA-512 digest (~16 bits)
export const POW_BUCKET_SEC = 300; // 5-minute windows

export const powBucketNow = () => Math.floor(Date.now() / 1000 / POW_BUCKET_SEC);

export function powMeets(hash: Uint8Array, zeros = POW_ZEROS): boolean {
  const need = Math.ceil(zeros / 2);
  let hex = "";
  for (let i = 0; i < need; i++) hex += hash[i].toString(16).padStart(2, "0");
  return hex.slice(0, zeros) === "0".repeat(zeros);
}

// Runs a tight synchronous loop — fast (avg ~32k SHA-512 at 16 bits, well under
// ~1s even on low-end phones) and only invoked once, at signup.
export function solvePow(username: string): { bucket: number; nonce: number } {
  const bucket = powBucketNow();
  const enc = new TextEncoder();
  for (let nonce = 0; ; nonce++) {
    if (powMeets(nacl.hash(enc.encode(`${username}:${bucket}:${nonce}`)))) return { bucket, nonce };
  }
}
