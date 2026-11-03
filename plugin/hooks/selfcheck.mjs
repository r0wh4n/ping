#!/usr/bin/env node
// Self-check for the plugin's non-obvious logic. Run: node plugin/hooks/selfcheck.mjs
// Covers the three things that were actually broken in the audit — @mention
// matching, room dedupe on re-join, and concurrent state writes.
import assert from "node:assert/strict";
import { mentionsMe, collectFresh } from "./ping-watch.mjs";
import { upsertRoom, roomsOf } from "./ping-state.mjs";
import { summarize } from "./ping-activity.mjs";

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

// --- fresh-message selection ----------------------------------------------
// Shared by the Stop hook and the PostToolUse hook; if these two ever disagree
// a message is delivered twice or not at all.
{
  const room = { token: "gm_a", group: "team", name: "me", last_seen: "2026-11-03T10:00:00Z" };
  const msgs = [
    { from: "ana", text: "old news", mine: false, created_at: "2026-11-03T09:00:00Z" },
    { from: "me", text: "my own line", mine: true, created_at: "2026-11-03T10:30:00Z" },
    { from: "ana", text: "deploy is green", mine: false, created_at: "2026-11-03T11:00:00Z" },
    { from: "ana", kind: "log", text: "edited useDM.ts", mine: false, created_at: "2026-11-03T11:01:00Z" },
  ];
  const r = collectFresh([room], [msgs], { active: "team" });
  assert.equal(r.anyFresh, true, "a newer message from someone else is fresh");
  assert.match(r.blocks[0], /deploy is green/, "delivers the new message");
  assert.doesNotMatch(r.blocks[0], /old news/, "never re-delivers what was already seen");
  assert.doesNotMatch(r.blocks[0], /my own line/, "never delivers my own message back to me");
  assert.match(r.blocks[0], /⚙ ana is working on: edited useDM\.ts/, "a status post is not rendered as something ana said");
  assert.equal(r.next[0].last_seen, "2026-11-03T11:01:00Z", "cursor advances to the newest delivered");
  assert.equal(collectFresh([room], [null], { active: "team" }).changed, false, "a failed poll leaves the cursor alone");
  // A room seen for the first time adopts history as read rather than replaying it.
  const first = collectFresh([{ ...room, last_seen: undefined }], [msgs], { active: "team" });
  assert.equal(first.anyFresh, false, "first sight of a room delivers nothing");
  assert.equal(first.next[0].last_seen, "2026-11-03T11:01:00Z", "but starts the cursor at the newest");
}

// --- activity summary -----------------------------------------------------
// The transcript mirrors every assistant turn into an `api-request-blob` entry
// with no timestamp; counting those too double-reported everything.
const entry = (ts, tools) =>
  JSON.stringify({ type: "assistant", timestamp: ts, cwd: "/Users/x/projects/ping", message: { content: tools } });
const edit = (p) => ({ type: "tool_use", name: "Edit", input: { file_path: p } });
const bash = (c) => ({ type: "tool_use", name: "Bash", input: { command: c } });

const lines = [
  entry("2026-11-03T10:00:00Z", [edit("/Users/x/projects/ping/src/hooks/useDM.ts")]),
  JSON.stringify({ type: "api-request-blob", message: { content: [edit("/Users/x/projects/ping/src/hooks/useDM.ts")] } }),
  entry("2026-11-03T10:05:00Z", [bash("npm run build"), bash("git commit -q -m \"Send video in a DM\"")]),
  "{ truncated half-written line",
];

const sum = summarize(lines, "");
assert.ok(sum, "activity must be summarised");
assert.match(sum.text, /useDM\.ts/, "names the file");
assert.doesNotMatch(sum.text, /\/Users\//, "never leaks an absolute path");
assert.match(sum.text, /npm run build/, "names the command");
assert.match(sum.text, /committed "Send video in a DM"/, "quotes the commit subject");
assert.equal((sum.text.match(/useDM\.ts/g) ?? []).length, 1, "api-request-blob must not double-count");
assert.equal(sum.until, "2026-11-03T10:05:00Z", "cursor advances to the newest entry");
assert.equal(summarize(lines, "2026-11-03T10:05:00Z"), null, "nothing new since the cursor -> no post");
assert.equal(summarize([entry("2026-11-03T11:00:00Z", [{ type: "tool_use", name: "Read", input: { file_path: "/x/a.ts" } }])], ""), null,
  "reading a file is not doing something");

console.log("selfcheck: all assertions passed");
