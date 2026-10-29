// Webhook signature verification — runnable check.
//
// Loads supabase/functions/group-hook/signature.ts directly (it is written as
// plain JS with JSDoc types, so Node can run the exact file the edge function
// imports) and checks it against GitHub's own published test vector. A MAC
// routine verified only against a second copy of itself proves nothing.
//
//   node scripts/check-webhook-signature.mjs

import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tmp = join(mkdtempSync(join(tmpdir(), "ping-sig-")), "signature.mjs");
copyFileSync("supabase/functions/group-hook/signature.ts", tmp);
const { checkSignature, hmacHex, sameSecret } = await import(pathToFileURL(tmp).href);

let pass = 0, fail = 0;
const ok = (name, cond) => (cond ? (pass++, console.log("  ok   " + name))
                                 : (fail++, console.log("  FAIL " + name)));
const bag = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });

// GitHub documents this exact pair, so it pins the algorithm itself: HMAC-SHA256
// over the raw body, hex encoded. Getting the encoding wrong still "works"
// against a self-made fixture; it does not work against this.
const SECRET = "It's a Secret to Everybody";
const BODY = "Hello, World!";
const GH = "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

ok("matches GitHub's published test vector", (await hmacHex(SECRET, BODY)) === GH);

ok("accepts GitHub's sha256= prefixed header",
  (await checkSignature(bag({ "x-hub-signature-256": `sha256=${GH}` }), BODY, SECRET)) === "good");

ok("accepts a bare hex signature (Linear)",
  (await checkSignature(bag({ "linear-signature": GH }), BODY, SECRET)) === "good");

ok("accepts the generic header",
  (await checkSignature(bag({ "x-ping-signature": GH }), BODY, SECRET)) === "good");

ok("is case-insensitive about the hex",
  (await checkSignature(bag({ "x-ping-signature": GH.toUpperCase() }), BODY, SECRET)) === "good");

// The four ways it must refuse.
ok("rejects a tampered body",
  (await checkSignature(bag({ "x-hub-signature-256": `sha256=${GH}` }), BODY + " ", SECRET)) === "bad");

ok("rejects the wrong secret",
  (await checkSignature(bag({ "x-hub-signature-256": `sha256=${GH}` }), BODY, "wrong")) === "bad");

ok("rejects a malformed header instead of throwing",
  (await checkSignature(bag({ "x-hub-signature-256": "sha256=nothex" }), BODY, SECRET)) === "bad");

ok("rejects a truncated signature",
  (await checkSignature(bag({ "x-ping-signature": GH.slice(0, 40) }), BODY, SECRET)) === "bad");

// "absent" is distinct from "bad" — the handler treats them differently, since
// a sender that has never signed is still being wired up.
ok("reports an unsigned request as absent, not bad",
  (await checkSignature(bag({}), BODY, SECRET)) === "absent");

// The compare itself.
ok("sameSecret is true for identical strings", sameSecret(GH, GH));
ok("sameSecret is false on a one-character difference",
  !sameSecret(GH, GH.slice(0, 63) + (GH[63] === "a" ? "b" : "a")));
ok("sameSecret is false on a length mismatch", !sameSecret(GH, GH.slice(0, 63)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
