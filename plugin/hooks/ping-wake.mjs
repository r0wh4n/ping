#!/usr/bin/env node
// Ping wake — Stop hook, run in the background (asyncRewake).
//
// The Stop hook in ping-watch.mjs looks once, the moment the agent stops. After
// that the session was deaf: a teammate could join or reply and nothing reached
// this agent until its person typed again, so "I'll tell you when they join"
// was a promise no agent could keep.
//
// Claude Code starts this when a session opens and whenever the agent stops,
// and does not wait for it. At session start too: until then a freshly opened
// session that nobody had typed into heard nothing — a request sent to it sat
// unread until its person happened to type. It
// long-polls the rooms for this folder; when someone else writes, it prints the
// messages to stderr and exits 2, which Claude Code turns into a reminder and a
// fresh turn. Exit 0 says nothing.
//
// Only in an interactive terminal session. `claude -p` runs background hooks in
// the foreground, so there this would hold the run open for as long as it
// waited (measured: a -p run took 15s instead of 4 with an 8s hook).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DIR, readState, roomsOf, roomMatchesCwd, VERSION } from "./ping-state.mjs";
import { API, ANON, readStdin, collectFresh, saveCursors, noteDead } from "./ping-watch.mjs";
import { popupAsks } from "./ping-notify.mjs";

const WAIT_S = 50; // the server's longest wait
// Stop listening after this long with nothing said; the next stop starts again.
// ponytail: each waiting session costs one request a minute; raise if that's cheap.
const LIFETIME_MS = 3 * 3600_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const interactive = (env = process.env) =>
  env.PING_WAKE === "1" || env.CLAUDE_CODE_ENTRYPOINT === "cli" || env.CLAUDE_CODE_SESSION_ATTENDED === "1";

async function waitRoom(room, signal) {
  // Not AbortSignal.any: hooks run on whatever node is on PATH, and 18 lacks it.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), (WAIT_S + 20) * 1000);
  signal.addEventListener("abort", () => ctl.abort(), { once: true });
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${room.token}`,
        "Content-Type": "application/json",
        "x-ping-plugin": VERSION,
      },
      // Our own cursor, so the shared one ping_read moves is left alone.
      body: JSON.stringify({ action: "wait", since: room.last_seen, seconds: WAIT_S }),
      signal: ctl.signal,
    });
    const data = await res.json();
    if (res.status === 401) return "dead";
    return Array.isArray(data?.messages) ? data.messages : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// First room with something new wins; the rest are cancelled.
async function waitAny(rooms) {
  const stop = new AbortController();
  const out = rooms.map(() => []);
  await new Promise((resolve) => {
    let left = rooms.length;
    rooms.forEach((room, i) =>
      waitRoom(room, stop.signal).then((msgs) => {
        out[i] = msgs;
        if ((Array.isArray(msgs) && msgs.length) || --left === 0) resolve();
      }));
  });
  stop.abort();
  return out.slice();
}

async function main() {
  if (!interactive()) process.exit(0);
  let input = {};
  try { input = JSON.parse((await readStdin()) || "{}"); } catch {}
  const session = String(input.session_id || "default").replace(/[^A-Za-z0-9_-]/g, "");
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();

  // One waiter per session: a newer stop replaces this one.
  mkdirSync(DIR, { recursive: true });
  const pidFile = join(DIR, `wake-${session}.pid`);
  writeFileSync(pidFile, String(process.pid));
  const superseded = () => {
    try { return readFileSync(pidFile, "utf8").trim() !== String(process.pid); } catch { return true; }
  };
  // Gone with the session: never advance a cursor for a session that cannot hear it.
  const claudePid = Number(process.env.CLAUDE_PID) || 0;
  const sessionGone = () => {
    if (!claudePid) return false;
    try { process.kill(claudePid, 0); return false; } catch { return true; }
  };

  // Let the foreground Stop hook move the cursors first, so this does not wake
  // the agent for what it was just shown.
  await sleep(2500);
  const started = Date.now();
  while (Date.now() - started < LIFETIME_MS) {
    if (superseded() || sessionGone()) process.exit(0);
    const state = readState();
    if (state.watch !== true) process.exit(0);
    const rooms = roomsOf(state).filter((r) => roomMatchesCwd(r, cwd) && r.last_seen);
    if (!rooms.length) process.exit(0);

    const results = await waitAny(rooms);
    if (superseded() || sessionGone()) process.exit(0);
    noteDead(rooms, results);
    if (results.every((r) => r === "dead")) process.exit(0); // left or removed everywhere
    if (results.every((r) => r === null || r === "dead")) { await sleep(15_000); continue; } // offline

    // Re-read: another hook may have delivered these while we waited.
    const now = readState();
    const fresh = rooms.map((r) => roomsOf(now).find((x) => x.token === r.token) ?? r);
    const { blocks, next, changed, anyNews, asks } = collectFresh(fresh, results.map((r) => (Array.isArray(r) ? r : null)), now);
    if (changed) saveCursors(next);
    // Status lines alone do not wake anyone: each one cost every idle agent in
    // the room a model turn. They are passed over here and shown mid-task.
    if (!anyNews) continue;

    const hint = now.active ? ` (your active room is "${now.active}")` : "";
    process.stderr.write(
      `📨 New Ping messages:\n${blocks.join("\n")}\n\n` +
      `Reply with the ping_say tool${hint} if a reply is needed. To reply in another room, pass its token shown above as room:"gm_…". If nothing is needed, stop.`
    );
    popupAsks(asks[0]?.agent, asks);
    process.exit(2);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
