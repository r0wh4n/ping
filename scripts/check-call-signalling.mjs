// Self-check for call signalling. Run: node --experimental-strip-types scripts/check-call-signalling.mjs
// Covers the two pieces that are wrong-by-default and have no browser in them:
// glare resolution, and the sealed SDP/ICE envelope.
//
// It does NOT exercise RTCPeerConnection — node has no WebRTC. A real media
// path needs two browsers; see the manual procedure in the PR notes.
import assert from "node:assert/strict";
import { keepsOutgoingCall } from "../src/lib/call.ts";
import { newKeyPair, encryptFor, decryptFrom, toB64 } from "../src/lib/crypto.ts";

// 1. Glare: exactly one of the two sides keeps its outgoing call, always.
const a = "0a11...", b = "f9ee...";
assert.equal(keepsOutgoingCall(a, b), true);
assert.equal(keepsOutgoingCall(b, a), false);
assert.notEqual(keepsOutgoingCall(a, b), keepsOutgoingCall(b, a), "both sides made the same choice — call would deadlock");
for (const [x, y] of [["1", "2"], ["aaa", "aab"], ["z", "a"]]) {
  assert.notEqual(keepsOutgoingCall(x, y), keepsOutgoingCall(y, x), `glare not symmetric for ${x}/${y}`);
}

// 2. Signalling envelope: an SDP sealed to the callee opens for them and nobody else.
const caller = newKeyPair(), callee = newKeyPair(), snoop = newKeyPair();
const sdp = { type: "offer", sdp: "v=0\r\no=- 42 2 IN IP4 127.0.0.1\r\n" };
const sealed = encryptFor(JSON.stringify(sdp), toB64(callee.pub), caller.sec);
assert.ok(!sealed.includes("v=0"), "SDP travelled in the clear");
assert.deepEqual(JSON.parse(decryptFrom(sealed, toB64(caller.pub), callee.sec)), sdp, "callee could not open the offer");
assert.equal(decryptFrom(sealed, toB64(caller.pub), snoop.sec), null, "a third party opened the signalling payload");

// 3. The unseal fallback: plaintext JSON contains ':' too, so the decrypt attempt
//    must fail soft and let the raw parse through rather than dropping the call.
const plain = JSON.stringify(sdp);
assert.ok(plain.includes(":"), "assumption broken: plaintext JSON has no colon");
assert.equal(decryptFrom(plain, toB64(caller.pub), callee.sec), null, "plaintext must not decrypt");
assert.deepEqual(JSON.parse(plain), sdp, "plaintext fallback parse failed");

console.log("call signalling: 3/3 checks passed");
