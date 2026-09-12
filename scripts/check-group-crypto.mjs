// Self-check for group E2E crypto. Run: node --experimental-strip-types scripts/check-group-crypto.mjs
// Fails loudly if the group key can be opened by the wrong person, if a body
// decrypts under the wrong key, or if tampering goes undetected.
import assert from "node:assert/strict";
import {
  newKeyPair,
  newGroupKey,
  sealGroupKeyFor,
  openGroupKey,
  encryptGroup,
  decryptGroup,
  toB64,
  epochOf,
  LEGACY_EPOCH,
} from "../src/lib/crypto.ts";

const alice = newKeyPair();   // creates the group
const bob = newKeyPair();     // member
const mallory = newKeyPair(); // not a member

// 1. Alice mints a key and seals it to Bob. Bob opens it and reads her message.
const key = newGroupKey();
const sealedForBob = sealGroupKeyFor(key, toB64(bob.pub), alice.sec);
const bobsKey = openGroupKey(sealedForBob, toB64(alice.pub), bob.sec);
assert.ok(bobsKey, "Bob could not open the group key sealed to him");
assert.deepEqual(bobsKey, key, "Bob opened a different key than Alice sealed");

const ct = encryptGroup("dinner at 8?", key, 1);
assert.notEqual(ct, "dinner at 8?", "body was not encrypted");
assert.equal(decryptGroup(ct, bobsKey), "dinner at 8?", "Bob could not read the message");

// 2. Alice seals to herself too, so her own history stays readable.
const sealedForAlice = sealGroupKeyFor(key, toB64(alice.pub), alice.sec);
assert.deepEqual(openGroupKey(sealedForAlice, toB64(alice.pub), alice.sec), key, "Alice locked herself out");

// 3. Mallory holds the row but not the recipient's secret — she gets nothing.
assert.equal(openGroupKey(sealedForBob, toB64(alice.pub), mallory.sec), null, "a non-member opened the group key");

// 4. A different group's key does not decrypt this group's messages.
assert.equal(decryptGroup(ct, newGroupKey()), null, "a foreign key decrypted the body");
assert.equal(decryptGroup(ct, null), null, "a missing key decrypted the body");

// 5. Tampering is detected, not silently decoded.
const [, nonce, box] = ct.split(":");
const flipped = Buffer.from(box, "base64");
flipped[0] ^= 0xff;
assert.equal(decryptGroup(`1:${nonce}:${flipped.toString("base64")}`, key), null, "tampered ciphertext was accepted");
assert.equal(decryptGroup("not-an-envelope", key), null, "malformed envelope was accepted");

// 6. A plaintext (pre-E2E) body must not decode under a key — the hook relies on
//    a null here to fall back to the lock glyph instead of leaking ciphertext.
assert.equal(decryptGroup("hello from 2025", key), null, "plaintext body decoded as ciphertext");
// Group bodies are full of colons ("meet at 5:30") — these must return null,
// not throw, or one bad row takes down the whole thread render.
assert.equal(decryptGroup("meet at 5:30", key), null, "colon-bearing plaintext threw instead of returning null");
assert.equal(decryptGroup("a:b", key), null, "non-base64 envelope threw instead of returning null");

// 7. Rotation. Someone leaves, the group mints epoch 2 for who remains. The
//    departed member still holds the epoch-1 key and must not read epoch-2 talk,
//    while epoch-1 history stays readable for everyone who was there.
const key2 = newGroupKey();
const after = encryptGroup("they left, speak freely", key2, 2);
assert.equal(epochOf(after), 2, "epoch was not carried in the envelope");
assert.equal(decryptGroup(after, key2), "they left, speak freely", "remaining members lost the new epoch");
assert.equal(decryptGroup(after, key), null, "the departed member's old key still decrypted new messages");
assert.equal(decryptGroup(ct, key), "dinner at 8?", "rotation broke old history");

// 8. Epoch parsing: pre-epoch bodies are 2-part and must read as epoch 1, and a
//    junk prefix must not throw or silently pick a wrong key.
assert.equal(epochOf("nonce:ciphertext"), LEGACY_EPOCH, "legacy envelope misparsed");
assert.equal(epochOf("x:nonce:ct"), LEGACY_EPOCH, "non-numeric epoch misparsed");
assert.equal(epochOf("0:nonce:ct"), LEGACY_EPOCH, "zero epoch misparsed");
assert.equal(epochOf("12:nonce:ct"), 12, "multi-digit epoch misparsed");

console.log("group crypto: 12/12 checks passed");
