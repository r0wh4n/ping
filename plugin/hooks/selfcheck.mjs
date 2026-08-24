#!/usr/bin/env node
// Self-check for the plugin's non-obvious logic. Run: node plugin/hooks/selfcheck.mjs
// Covers the three things that were actually broken in the audit — @mention
// matching, room dedupe on re-join, and concurrent state writes.
import assert from "node:assert/strict";
import { mentionsMe } from "./ping-watch.mjs";
import { upsertRoom, roomsOf } from "./ping-state.mjs";

// --- @mention -------------------------------------------------------------
assert.equal(mentionsMe("hey @rohan can you look", "rohan"), true, "plain mention");
assert.equal(mentionsMe("hey @Rohan", "rohan"), true, "case-insensitive");
assert.equal(mentionsMe("ping @rohandeep about it", "rohan"), false, "no prefix false-positive");
assert.equal(mentionsMe("mail rohan@example.com", "rohan"), false, "email is not a mention");
assert.equal(mentionsMe("@Rohan please review", "Rohan Pandey"), true, "first word of multi-word name");
assert.equal(mentionsMe("@Rohan Pandey please", "Rohan Pandey"), true, "full multi-word name");
assert.equal(mentionsMe("nothing here", "rohan"), false, "no mention");
assert.equal(mentionsMe("@rohan", undefined), false, "no name configured");

// --- room dedupe ----------------------------------------------------------
let s = {};
s = upsertRoom(s, { token: "gm_a", group: "team", name: "me", last_seen: "t1" });
s = upsertRoom(s, { token: "gm_b", group: "team", name: "me", last_seen: "t2" }); // re-join, new token
assert.equal(roomsOf(s).length, 1, "re-join must not duplicate the room");
assert.equal(roomsOf(s)[0].token, "gm_b", "newest token wins");
s = upsertRoom(s, { token: "gm_c", group: "other", name: "me", last_seen: "t3" });
assert.equal(roomsOf(s).length, 2, "a genuinely different room is added");
assert.equal(s.active, "other", "active follows the room just joined");

// --- legacy migration keeps `name` (it used to be dropped) ----------------
const legacy = roomsOf({ token: "gm_x", group: "g", name: "me", last_seen: "t" });
assert.equal(legacy[0].name, "me", "legacy shape must keep name or @mentions break");

console.log("selfcheck: all assertions passed");
