#!/usr/bin/env node
// Checks for Ping's room encryption. Security logic, so this runs in `npm run
// check` and the build fails without it.
import assert from "node:assert/strict";
import {
  MARKER, newRoomKey, keyFrom, keyFromLink, linkWithKey,
  seal, open, openDeep, sealArgs,
} from "../plugin/hooks/ping-crypto.mjs";

const key = keyFrom(newRoomKey());
const other = keyFrom(newRoomKey());
assert.ok(key && key.length === 32, "a fresh room key is 32 bytes");

// Round trip, including the things people actually paste into a room.
for (const text of ["hello", "", "a".repeat(20000), "🔐 émoji ✓", '{"json":"like"}', "ping-e2e:v1:not-really"]) {
  const sealed = seal(text, key);
  assert.equal(open(sealed, key), text, `round trips: ${text.slice(0, 20)}`);
}

// The server must not be able to see the message in what it stores.
const secret = "the database password is hunter2";
const sealed = seal(secret, key);
assert.ok(sealed.startsWith(MARKER), "sealed text is marked so any client can explain itself");
assert.ok(!sealed.includes(secret), "plaintext does not survive in the envelope");
assert.ok(!sealed.includes("hunter2"), "nor any part of it");

// Nonce reuse would leak that two messages are identical. Sealing the same text
// twice must not produce the same bytes.
assert.notEqual(seal(secret, key), seal(secret, key), "each seal uses a fresh IV");

// The wrong key must fail closed. Returning "" here would read as "they said
// nothing" rather than "you cannot read this".
assert.equal(open(sealed, other), sealed, "a wrong key yields the envelope, not empty text");
assert.equal(open(sealed, null), sealed, "no key yields the envelope");

// GCM must reject tampering rather than return altered plaintext.
const [iv, bodyB64] = sealed.slice(MARKER.length).split(":");
const body = Buffer.from(bodyB64, "base64url");
body[0] ^= 0xff;
assert.equal(open(`${MARKER}${iv}:${body.toString("base64url")}`, key), `${MARKER}${iv}:${body.toString("base64url")}`,
  "a flipped bit fails to open");

// A room mixes encrypted members with plaintext webhooks. Both must render.
assert.equal(open("a plain webhook line", key), "a plain webhook line", "plaintext passes through untouched");
assert.equal(open(MARKER + "garbage", key), MARKER + "garbage", "a malformed envelope passes through");

// Responses are walked generically, because their shapes differ per tool.
const resp = openDeep({
  ok: true, count: 2,
  messages: [{ from: "a", text: seal("first", key) }, { from: "b", text: "plain" }],
  open_tasks: [{ title: seal("do the thing", key), artifact: seal("DIFF", key) }],
}, key);
assert.equal(resp.messages[0].text, "first", "nested message text opens");
assert.equal(resp.messages[1].text, "plain", "nested plaintext survives");
assert.equal(resp.open_tasks[0].artifact, "DIFF", "task artifacts open");
assert.equal(resp.count, 2, "non-strings are left alone");
assert.ok(openDeep(null, key) === null, "null is safe");

// Cycles must not hang the agent.
const cycle = { a: 1 }; cycle.self = cycle;
assert.ok(openDeep(cycle, key), "a cyclic object terminates");

// Outgoing arguments: content sealed, routing left legible.
const args = sealArgs("ping_task", { title: "ship it", detail: "the brief", artifact: "DIFF", skills: ["go"] }, key);
assert.ok(args.title.startsWith(MARKER) && args.detail.startsWith(MARKER) && args.artifact.startsWith(MARKER),
  "task content is sealed");
assert.deepEqual(args.skills, ["go"], "skills stay clear so the server can match them");

// Joining must stay legible or the server cannot attribute or route anything.
const join = sealArgs("ping_join", { link: "gk_x", name: "maya" }, key);
assert.equal(join.name, "maya", "display names are not sealed");
assert.deepEqual(sealArgs("ping_say", { text: "hi" }, null), { text: "hi" }, "no key means no change");

// The key rides in the fragment, which is never sent to a server.
const link = linkWithKey("https://theping.chat/g/gk_abc", "KEY123");
assert.equal(link, "https://theping.chat/g/gk_abc#k=KEY123", "the key goes in the fragment");
assert.equal(keyFromLink(link), "KEY123", "and comes back out");
assert.equal(keyFromLink("https://theping.chat/g/gk_abc"), null, "a plain link has no key");
assert.equal(keyFromLink("https://theping.chat/g/gk_abc#other=1&k=K2"), "K2", "found among other fragment params");
assert.equal(linkWithKey("https://theping.chat/g/gk_abc#k=OLD", "NEW"), "https://theping.chat/g/gk_abc#k=NEW",
  "replacing a key does not stack fragments");

// A truncated or mistyped key must be rejected, not quietly used short.
assert.equal(keyFrom("tooshort"), null, "a short key is refused");
assert.equal(keyFrom(""), null, "an empty key is refused");
assert.equal(keyFrom(null), null, "a missing key is refused");

// Interop: Mission Control opens these in the browser with WebCrypto, from a
// separate implementation. Two implementations of one envelope drift silently —
// the page would just show ciphertext forever — so prove they agree here.
// Node exposes the same globals (crypto.subtle, atob), so the browser module
// runs as-is.
const browser = await import("../src/lib/roomKeys.ts");
const keyB64 = newRoomKey();
const nodeKey = keyFrom(keyB64);
const webKey = await browser.importRoomKey(keyB64);
assert.ok(webKey, "the browser accepts a key the plugin minted");

for (const text of ["hello from the plugin", "🔐 émoji ✓", "x".repeat(5000)]) {
  assert.equal(await browser.openText(seal(text, nodeKey), webKey), text,
    "the browser opens what the plugin sealed");
}
assert.equal(await browser.openText("a plain webhook line", webKey), "a plain webhook line",
  "plaintext passes through in the browser too");
assert.ok(browser.isSealed(seal("x", nodeKey)), "the browser recognises the envelope");
const sealedX = seal("the wrong key must not open this", nodeKey);
const wrongWebKey = await browser.importRoomKey(newRoomKey());
assert.equal(await browser.openText(sealedX, wrongWebKey), sealedX,
  "a wrong key in the browser yields the envelope, not plaintext");
assert.equal(await browser.openText(sealedX, null), sealedX, "no key in the browser yields the envelope");
assert.equal(await browser.importRoomKey("tooshort"), null, "the browser refuses a short key");
assert.equal(await browser.importRoomKey(null), null, "the browser refuses a missing key");

// The unlock box takes whichever of the two a person has to hand.
assert.equal(browser.keyFromInput(`https://theping.chat/g/gk_abc#k=${keyB64}`), keyB64, "unlock accepts a link");
assert.equal(browser.keyFromInput(` ${keyB64} `), keyB64, "unlock accepts a bare key");
assert.equal(browser.keyFromInput("not a key"), null, "unlock rejects junk");

// Mission Control decrypts whole timelines, titles included.
const rows = await browser.openAll(
  [{ text: seal("sealed", nodeKey), title: seal("a title", nodeKey) }, { text: "plain", title: null }],
  webKey
);
assert.equal(rows[0].text, "sealed", "timeline text opens");
assert.equal(rows[0].title, "a title", "timeline titles open");
assert.equal(rows[1].text, "plain", "plaintext rows survive");

console.log("check-room-e2e: all assertions passed (node + browser interop)");
