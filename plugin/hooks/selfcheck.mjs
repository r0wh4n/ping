#!/usr/bin/env node
// Self-check for the plugin's non-obvious logic. Run: node plugin/hooks/selfcheck.mjs
// Covers the three things that were actually broken in the audit — @mention
// matching, room dedupe on re-join, and concurrent state writes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mentionsMe, collectFresh, statusRoom } from "./ping-watch.mjs";
import { upsertRoom, roomsOf, dropRoom, hooksHealth, HOOK_TICK_MS, VERSION } from "./ping-state.mjs";
import { summarize, describeCommit, describeWork, parseCommitLog, parseStatus, taskFrom } from "./ping-activity.mjs";
import { takeFlags } from "./ping-connect.mjs";
import { classifyTask, isHumanPrompt, cleanPrompt, patchPaths, transcriptPrompt, transcriptTurn, claimOnce, appendLine, readLines } from "./ping-adapter.mjs";
import { mkdtempSync, writeFileSync as writeTmp } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { newRoomKey, keyFrom, seal, openDeep } from "./ping-crypto.mjs";

// --- @mention -------------------------------------------------------------
assert.equal(mentionsMe("hey @rohan can you look", "rohan"), true, "plain mention");
assert.equal(mentionsMe("hey @Rohan", "rohan"), true, "case-insensitive");
assert.equal(mentionsMe("ping @rohandeep about it", "rohan"), false, "no prefix false-positive");
assert.equal(mentionsMe("mail rohan@example.com", "rohan"), false, "email is not a mention");
assert.equal(mentionsMe("@Rohan please review", "Rohan Pandey"), true, "first word of multi-word name");
assert.equal(mentionsMe("@Rohan Pandey please", "Rohan Pandey"), true, "full multi-word name");
assert.equal(mentionsMe("nothing here", "rohan"), false, "no mention");
assert.equal(mentionsMe("@rohan", undefined), false, "no name configured");

// --- sealed values inside a server-built string ---------------------------
// ping_digest and ping_catchup paste the whole timeline into ONE field, each
// line prefixed with "[author · kind] ". Nothing started with the marker, so
// nothing opened: the digest handed the agent a wall of ciphertext and asked
// it to summarise a day's work from it.
{
  const key = keyFrom(newRoomKey());
  const timeline = `[rohan · log] ${seal("working on the frontend", key)}\n[Mac · log] ${seal("shipped it", key)}`;
  const opened = openDeep({ timeline }, key).timeline;
  assert.match(opened, /\[rohan · log\] working on the frontend/, "an embedded sealed value opens in place");
  assert.match(opened, /\[Mac · log\] shipped it/, "every one of them, not just the first");
  assert.doesNotMatch(opened, /ping-e2e:/, "nothing sealed is left behind");
  // A message that merely talks about ciphertext must survive untouched.
  const chat = "it showed ping-e2e:v1:aaaa:bbbb which means it failed";
  assert.equal(openDeep({ t: chat }, key).t, chat, "an undecryptable match is left exactly as it was");
}

// --- hook adapters (Codex, Command Code) -----------------------------------
// The adapters report another agent's work as a label and an area only. Each of
// these was learned from a real run, not from the docs.
{
  assert.equal(classifyTask("Create a tic-tac-toe page in tic-tac-toe.html, then reply with done."), "building", "making something is building");
  assert.equal(classifyTask("tell me 5 news of security"), "researching", "news is research, not building");
  assert.equal(classifyTask("Read README.txt and reply with its first word."), "reading", "read-only requests say so");
  assert.equal(classifyTask("hello there"), "working on a task", "no verb, no guess");
  assert.equal(isHumanPrompt("Create a tic-tac-toe page"), true, "a short request is a person's");
  assert.equal(isHumanPrompt("## Memory Writing Agent: Phase 2 (Consolidation)\n" + "x".repeat(3000)), false,
    "Codex's own background turn is not work to report");
  assert.equal(cleanPrompt("<system-reminder>be nice</system-reminder>  fix the login bug"), "fix the login bug", "injected blocks are stripped");
  assert.deepEqual(patchPaths("*** Begin Patch\n*** Add File: hello.txt\n+hi\n*** Update File: src/app.tsx\n*** End Patch"),
    ["hello.txt", "src/app.tsx"], "only the file names from an apply_patch");
  const dir = mkdtempSync(joinPath(tmpdir(), "ping-adapter-"));
  const tp = joinPath(dir, "t.jsonl");
  writeTmp(tp, [
    JSON.stringify({ type: "session", id: "s" }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "first request" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "tool_use", name: "write_file" }] } }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "second request" }] } }),
    "",
  ].join("\n"));
  assert.equal(transcriptPrompt(tp), "second request", "the latest request with text, never a tool result");
  assert.equal(transcriptPrompt(joinPath(dir, "missing.jsonl")), null, "no transcript yet means no request yet");

  // Hooks for one event run in parallel. A live room got the same started line twice,
  // a second apart, because two processes each saw "not started yet".
  const marker = joinPath(dir, "turn.started");
  assert.equal(claimOnce(marker), true, "the first claim wins");
  assert.equal(claimOnce(marker), false, "every later claim loses, so a line posts once");
  const lp = joinPath(dir, "turn.paths");
  appendLine(lp, "src/a.tsx");
  appendLine(lp, "src/b.tsx");
  assert.deepEqual(readLines(lp), ["src/a.tsx", "src/b.tsx"], "appended paths all survive");
  // "continue" twice is two turns; keying on text alone would silence the second.
  const rp = joinPath(dir, "repeat.jsonl");
  const msg = (role, text) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
  writeTmp(rp, [msg("user", "continue"), msg("assistant", "ok"), msg("user", "continue")].join("\n"));
  assert.equal(transcriptTurn(rp).index, 2, "the latest request, identified by its position, not its text");
}

// --- join flags ------------------------------------------------------------
// Windows PowerShell strips embedded double quotes when it calls a native
// binary, so a quoted two-word name arrives as two bare words. Taking only the
// first of them joined a live room under a silently wrong name and spilled the
// rest into the invite link.
{
  const link = "https://theping.chat/g/gk_x#k=K";
  assert.equal(takeFlags(`${link} --name "rohan ec2" --role backend`).flags.name, "rohan ec2", "quoted name");
  assert.equal(takeFlags(`${link} --name rohan ec2 --role backend`).flags.name, "rohan ec2", "unquoted, as PowerShell delivers it");
  assert.equal(takeFlags(`${link} --name rohan ec2 --role backend`).rest, link, "the link survives intact");
  assert.equal(takeFlags(`${link} --name rohan ec2 --role backend`).flags.role, "backend", "the next flag still ends the previous one");
  assert.equal(takeFlags(`--name rohan ec2 ${link}`).rest, link, "a link after the flag is not swallowed by it");
  assert.equal(takeFlags(`${link} --name --role backend`).flags.name, undefined, "a flag is not a value");
}

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

// A teammate should learn what kind of work happened, not read your shell
// history. Posting file and command lists turned a day into 134 unreadable
// lines and described how someone works in far more detail than they agreed to.
const sum = summarize(lines, "");
assert.ok(sum, "activity must be summarised");
assert.match(sum.text, /shipped a change to the frontend/, "says what kind of work it was");
assert.match(sum.text, /"Send video in a DM"/, "keeps the commit subject, which is written to be read");
assert.doesNotMatch(sum.text, /useDM/, "never names a file");
assert.doesNotMatch(sum.text, /npm run build/, "never names a command");
assert.doesNotMatch(sum.text, /\/Users\//, "never leaks an absolute path");
assert.equal(sum.until, "2026-11-03T10:05:00Z", "cursor advances to the newest entry");

// Edits with no commit: still worth a line, still no file names.
{
  const edits = summarize([entry("2026-11-03T12:00:00Z", [edit("/Users/x/projects/ping/supabase/functions/group-api/index.ts")])], "");
  assert.equal(edits.text, "ping · working on the backend", "edits alone say where, not what file");
}

// Housekeeping commands used to post "ran ls, cd" — noise with no signal.
assert.equal(summarize([entry("2026-11-03T13:00:00Z", [bash("ls"), bash("cd /tmp")])], ""), null,
  "unrecognised commands post nothing");
assert.match(summarize([entry("2026-11-03T13:00:00Z", [bash("npm test")])], "").text, /running tests/,
  "but a test run is worth saying");

// A commit subject is the one piece of free text that reaches the room, so it
// has to come from a real commit. Both of these were caught by running the
// summariser over an actual session transcript, not by the fixture above.
{
  // A script that merely MENTIONS the words donated its subject to the room:
  // a live session posted `shipped a change — "base"` from a Python heredoc.
  const impostor = bash(`cd /tmp/x && python3 - <<'PY'\ns = 'git commit -m "base"'\nPY`);
  assert.equal(summarize([entry("2026-11-03T14:00:00Z", [impostor])], ""), null,
    "a command that only mentions git commit is not a commit");

  // The heredoc delimiter is whatever the caller picked; only EOF was handled,
  // so every <<'MSG' commit silently lost its subject.
  const msg = bash(`git add -A && git commit -q -F - <<'MSG'\nSay what kind of work happened\nMSG`);
  assert.match(summarize([entry("2026-11-03T15:00:00Z", [msg])], "").text,
    /shipped a change — "Say what kind of work happened"/, "any heredoc delimiter, not just EOF");

  // The shape this repo actually commits in. Splitting the command on && put
  // the redirect and its body in different segments, so the subject vanished
  // and the room was told nothing at all — the live room stayed silent through
  // two real commits before this was caught.
  const chained = bash(`git commit -q -F - <<'MSG' && git log --oneline -1\nRead a commit subject only from the command that makes it\n\nbody line\nMSG`);
  assert.match(summarize([entry("2026-11-03T16:00:00Z", [chained])], "").text,
    /shipped a change — "Read a commit subject only from the command that makes it"/,
    "a heredoc whose body is separated from its redirect by &&");
}
assert.equal(summarize(lines, "2026-11-03T10:05:00Z"), null, "nothing new since the cursor -> no post");
assert.equal(summarize([entry("2026-11-03T11:00:00Z", [{ type: "tool_use", name: "Read", input: { file_path: "/x/a.ts" } }])], ""), null,
  "reading a file is not doing something");

// --- the task, in the person's own words ----------------------------------
// Effects cannot say what work was FOR: "working on the frontend" was true of
// building a game and of deleting one, and a room full of it told nobody
// anything. This is the only place something a person typed leaves the
// machine, so what it does and does not take matters.
{
  const user = (content) => ({ type: "user", timestamp: "2026-11-03T09:00:00Z", message: { content } });
  assert.equal(taskFrom(user("delete the snakegame and tell me about top 5 security news")),
    "delete the snakegame and tell me about top 5 security news", "a plain request is the task");
  assert.equal(taskFrom(user([{ type: "text", text: "add a dark mode toggle" }])), "add a dark mode toggle",
    "content blocks too");
  assert.equal(taskFrom(user([{ type: "tool_result", content: "ok" }])), null,
    "a tool result is machine output, not a request");
  assert.equal(taskFrom(user("/ping status on")), null, "a slash command is not a task");
  assert.equal(taskFrom(user("  ")), null, "nothing typed, nothing to say");
  assert.equal(taskFrom(user("<system-reminder>be nice</system-reminder> fix the login bug")), "fix the login bug",
    "injected blocks are stripped, not reported");
  // One sentence only: the room gets the request, never the whole message.
  assert.equal(taskFrom(user("fix the login bug. it has been broken since Tuesday and nobody noticed")),
    "fix the login bug.", "only the first sentence");
  const whole = ("please " + "refactor the authentication layer ".repeat(6)).replace(/\s+/g, " ").trim();
  const long = taskFrom(user(whole));
  assert.ok(long.length <= 111, "capped");
  assert.match(long, /…$/, "and marked as trimmed");
  const kept = long.slice(0, -1);
  assert.ok(whole.startsWith(kept), "what it keeps is the start of what was typed, unaltered");
  assert.equal(whole[kept.length], " ", "and it stops at a space — never mid-word");
}

// --- what the proxy posts for a client with no hooks ----------------------
// Cursor, Codex and Command Code have no hook system, so nothing they did ever
// reached the room. The proxy reads git instead — the one record of work every
// client leaves — and must phrase it exactly as the hook does, or the same
// work would read differently depending on which app someone happened to use.
{
  const log = "\x01" + "2026-11-19T10:00:00Z\x00me@example.com\x00Add the invite expiry\nsrc/app/page.tsx\nsrc/lib/invite.ts\n"
            + "\x01" + "2026-11-19T10:05:00Z\x00THEM@example.com\x00Harden the join guard\nsupabase/functions/group-api/index.ts\n";
  const commits = parseCommitLog(log);
  assert.equal(commits.length, 2, "both commits parsed from one exec");
  assert.equal(commits[0].subject, "Add the invite expiry", "subject split from the timestamp and author");
  assert.deepEqual(commits[1].files, ["supabase/functions/group-api/index.ts"], "files belong to their own commit");
  // A pull lands everyone else's commits in the same window. Without the
  // author, the first teammate to pull told the room they had shipped work
  // somebody else wrote — it happened in a live room, four minutes after.
  assert.equal(commits[0].email, "me@example.com", "author carried, for filtering to this machine");
  assert.equal(commits[1].email, "them@example.com", "and lowercased, since git addresses vary in case");
  assert.equal(commits.filter((c) => c.email === "me@example.com").length, 1, "someone else's commit is separable");
  assert.equal(describeCommit(commits[1].subject, commits[1].files),
    'shipped a change to the backend — "Harden the join guard"', "same sentence the hook writes");
  assert.equal(parseCommitLog("").length, 0, "no commits, nothing to say");

  assert.deepEqual(parseStatus(" M src/app/page.tsx\n?? notes.md\nR  a.ts -> b.ts\n"),
    ["src/app/page.tsx", "notes.md", "b.ts"], "porcelain, renames included");
  assert.equal(describeWork(["src/app/page.tsx"]), "working on the frontend", "a dirty tree is work in flight");
  assert.equal(describeWork([]), null, "a clean tree says nothing");
  assert.equal(describeWork(["plugin/hooks/ping-mcp.mjs"]), "working on tooling", "the plugin's own files classify");
  // The case this was built for: an agent asked for a calculator writes a few
  // files somewhere with no repo at all, and the room heard nothing.
  assert.equal(describeWork(["C:/Users/Administrator/Desktop/calc/index.html", "C:/Users/Administrator/Desktop/calc/style.css"]),
    "working on the frontend", "plain files outside a repo still say something");
}

// --- where an automatic status post goes ----------------------------------
// `status on` with no active room used to post nowhere, silently, forever.
{
  const team = { token: "gm_a", group: "team" };
  const other = { token: "gm_b", group: "other" };
  assert.equal(statusRoom([team, other], "other"), other, "the active room wins");
  assert.equal(statusRoom([team], undefined), team, "no active room, one room -> post there");
  assert.equal(statusRoom([team, other], undefined), null, "no active room, several -> never guess");
  assert.equal(statusRoom([], "team"), null, "no rooms -> nothing to post to");
}

// --- leaving a room ---------------------------------------------------------
// ping_leave voids the token server-side; the entry used to survive here, so
// the hooks polled a dead credential and `active` named a room you had left.
{
  let s = {};
  s = upsertRoom(s, { token: "gm_a", group: "team", name: "me" });
  s = upsertRoom(s, { token: "gm_b", group: "other", name: "me" });
  assert.equal(s.active, "other", "joined room is active");
  s = dropRoom(s, "gm_b");
  assert.equal(roomsOf(s).length, 1, "the room you left is gone");
  assert.equal(roomsOf(s)[0].token, "gm_a", "and the other one is untouched");
  assert.equal(s.active, undefined, "active is cleared, never guessed at");
  assert.equal(dropRoom(s, "gm_nope").rooms.length, 1, "leaving a room twice is harmless");
  const keep = dropRoom({ active: "team", rooms: [{ token: "gm_a", group: "team" }, { token: "gm_c", group: "c" }] }, "gm_c");
  assert.equal(keep.active, "team", "leaving a room that wasn't active leaves `active` alone");
}

// --- re-joining a room you are already in --------------------------------
// The whole dedupe hangs on the invite code surviving a state round trip. If
// upsertRoom ever drops it, /ping silently mints a second membership again.
{
  const s2 = upsertRoom({}, { token: "gm_a", group: "team", name: "me", code: "gk_abc" });
  assert.equal(roomsOf(s2)[0].code, "gk_abc", "the invite code must be remembered, or re-join dedupe stops working silently");
  const s3 = upsertRoom(s2, { token: "gm_b", group: "team", name: "me", code: "gk_abc" });
  assert.equal(roomsOf(s3).length, 1, "a re-join must still collapse to one room locally");
}

// --- noticing that the hooks are dead ---------------------------------------
// The manifest check above stops the registration being malformed. This stops
// the OTHER half of the same fifteen days: hooks that are fine but were never
// registered, because the plugin was installed into a running session. The
// plugin cannot see its own registration, but it can see that nothing has run.
{
  const now = Date.UTC(2026, 10, 18, 12, 0, 0);
  const at = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();
  assert.equal(hooksHealth({ watch: true, live_at: at(0.5) }, now).stale, false, "a hook that ran 30s ago is alive");
  assert.equal(hooksHealth({ watch: true, live_at: at(60 * 24 * 15) }, now).stale, true, "fifteen days is not a slow tick");
  assert.equal(hooksHealth({ watch: true }, now).stale, true, "never having run is the fresh-install case and must warn");
  // watch off stops ping-live before it writes, so a stale stamp proves nothing.
  assert.equal(hooksHealth({ watch: false }, now).stale, false, "paused delivery must not be reported as a broken hook");
  assert.equal(hooksHealth({ watch: true, status_at: at(0.5) }, now).stale, false, "either hook running counts");
  assert.equal(hooksHealth({ watch: true, live_at: at(2) }, now).stale, false, "a couple of idle ticks is not a fault");
  assert.ok(HOOK_TICK_MS > 0, "the tick the threshold is built from must be real");
}

// --- the hook manifest ------------------------------------------------------
// Claude Code reads each entry under an event as a MATCHER GROUP and looks for
// a `hooks` array inside it. This file listed the command objects directly, so
// every entry was read as a group with no hooks in it and silently dropped --
// no error, no warning, and `/ping status on` still answered ok. Both hooks
// were dead for fifteen days before anyone could see it: the room simply stayed
// quiet, and the obvious conclusion was that the product did not work.
{
  const manifest = JSON.parse(readFileSync(new URL("./hooks.json", import.meta.url), "utf8"));
  const events = Object.entries(manifest.hooks ?? {});
  assert.ok(events.length, "the manifest must register at least one hook");
  for (const [event, groups] of events) {
    assert.ok(Array.isArray(groups) && groups.length, `${event} must list at least one matcher group`);
    for (const group of groups) {
      assert.ok(Array.isArray(group.hooks) && group.hooks.length,
        `${event}: a matcher group needs a hooks[] array — commands placed directly in the group are ignored without error`);
      for (const h of group.hooks) {
        assert.equal(h.type, "command", `${event}: every hook runs a command`);
        assert.match(h.command, /\$\{CLAUDE_PLUGIN_ROOT\}/, `${event}: reference the plugin by CLAUDE_PLUGIN_ROOT, never a version-pinned path`);
      }
    }
  }
}

// --- the version we report to the server ----------------------------------
// It is sent as x-ping-plugin and is the only thing that tells the server an
// install is stale; a hardcoded copy drifted twice before it was read here.
assert.match(VERSION, /^\d+\.\d+\.\d+$/, "VERSION must come from the manifest, not a stale literal");

console.log(`selfcheck: all assertions passed (plugin ${VERSION})`);
