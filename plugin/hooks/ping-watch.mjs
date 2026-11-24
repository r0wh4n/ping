#!/usr/bin/env node
// Ping auto-delivery — Stop hook (multi-room).
//
// Fires when the agent goes idle. Checks EVERY Ping room you've joined for
// messages from others since we last looked; if any, it blocks the stop and
// injects them (labeled by room) so the agent picks them up on its own — no
// "check inbox". Nothing new -> let it stop.
//
// State (~/.ping/state.json): { watch, active, rooms: [{token, group, path, last_seen}] }.
// Old single-room shape { token, group, last_seen } is migrated on read. Each
// room keeps its OWN cursor; we send it as `since` so the server never advances
// the shared last_read that interactive ping_read/ping_wait depend on.
//
// Rooms are scoped to the directory they were joined in. The state file is
// machine-global, so without this every room you have ever joined is delivered
// into whatever project you happen to be working in — along with its write
// token. Someone in three clients' rooms would have all three in one context.
// Rooms with no path stay global, so nothing changes for existing setups.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { readState, updateState, roomsOf, roomMatchesCwd, dropRoom, VERSION } from "./ping-state.mjs";
import { keyFrom, open, seal } from "./ping-crypto.mjs";

const execFileP = promisify(execFile);

// PING_API: point a checkout at a test deploy of the function.
export const API = process.env.PING_API || "https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1/group-api";
export const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzZHNsa3hkb3F3c3BqZm96d3ZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5ODg3NjQsImV4cCI6MjEwMDU2NDc2NH0.Kuop6VvV3Ykak8SqH8yBJbt0H6N-mB2-riSVFQS7aDo";
const FLOOR = "0000-01-01T00:00:00+00:00"; // sorts before any real timestamp

const allowStop = () => process.exit(0); // no stdout + exit 0 => agent stops normally

// Does this message @mention me? A plain substring match was wrong twice over:
// "@rohan" fired on "@rohandeep" and on "rohan@example.com", while anyone whose
// display name had a space ("Rohan Pandey") could never be mentioned at all,
// since people type "@Rohan". So: match the full name OR its first word, require
// the @ to start a token, and stop at a name-character boundary.
export function mentionsMe(text, name) {
  if (!name) return false;
  const t = String(text || "");
  const candidates = [String(name), String(name).trim().split(/\s+/)[0]].filter(Boolean);
  return candidates.some((c) => {
    const esc = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_@-])@${esc}(?![A-Za-z0-9_-])`, "i").test(t);
  });
}

export function readStdin() {
  return new Promise((res) => {
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 500); // fallback if no stdin (e.g. manual run)
  });
}

export async function pollRoom(room) {
  try {
    const { stdout } = await execFileP(
      "curl",
      [
        "-s", "-X", "POST", API,
        "-H", `apikey: ${ANON}`,
        "-H", `Authorization: Bearer ${room.token}`,
        "-H", "Content-Type: application/json",
        "-H", `x-ping-plugin: ${VERSION}`,
        // our own cursor => server won't move the shared last_read
        "-d", JSON.stringify({ action: "read", since: room.last_seen || FLOOR }),
      ],
      { timeout: 10000 }
    );
    const data = JSON.parse(stdout);
    if (data?.ok === false && DEAD.test(String(data.error ?? ""))) return "dead";
    return Array.isArray(data?.messages) ? data.messages : [];
  } catch {
    return null; // network/parse hiccup -> skip this room, leave its cursor
  }
}

// What the server says about a token whose membership no longer exists (old
// wording and new). Anything else — a timeout, a 500 — is not "gone".
export const DEAD = /no longer in any room|Invalid or expired member token/i;

// A room the server says is gone stays on this machine until it has said so
// three times, at least two minutes apart from the first: the token is the
// only way back into a room, and one bad response must not throw it away. Then
// the room is dropped, so nothing polls it every few seconds for ever — a
// deleted room was still being asked about hours later.
export const DEAD_STRIKES = 3;
export const DEAD_AFTER_MS = 120_000;
export function markDead(state, verdicts, now = Date.now()) {
  let next = state;
  for (const r of roomsOf(state)) {
    const v = verdicts.get(r.token);
    if (v === "dead") {
      const since = r.dead_since ?? new Date(now).toISOString();
      const count = (r.dead_count ?? 0) + 1;
      next = count >= DEAD_STRIKES && now - Date.parse(since) >= DEAD_AFTER_MS
        ? dropRoom(next, r.token)
        : { ...next, rooms: roomsOf(next).map((x) => (x.token === r.token ? { ...x, dead_since: since, dead_count: count } : x)) };
    } else if (v === "alive" && r.dead_count) {
      next = { ...next, rooms: roomsOf(next).map((x) => (x.token === r.token ? { ...x, dead_since: undefined, dead_count: undefined } : x)) };
    }
  }
  return next;
}
export function noteDead(rooms, results) {
  const verdicts = new Map(rooms.map((r, i) => [r.token, results[i] === "dead" ? "dead" : Array.isArray(results[i]) ? "alive" : null]));
  if ([...verdicts.values()].some((v) => v === "dead") || rooms.some((r) => r.dead_count)) {
    updateState((cur) => markDead(cur, verdicts));
  }
}

/**
 * Which room an automatic status post goes to (ping-summary.mjs).
 *
 * The active room — or, if none is set, the only room there is. Without that
 * second half `status on` was a silent no-op for anyone whose state had no
 * `active` (a room joined before active existed, or a state file that lost it):
 * the gate below returned every tick, forever, while /ping cheerfully reported
 * status on. ping-mcp.mjs's activeRoom() and `/ping here` already fall back
 * this way; this was the one place that didn't.
 *
 * Deliberately NOT ping-mcp's "last room" fallback. That one serves a call the
 * person just made by hand; this one fires on a timer with nobody watching, and
 * guessing wrong posts your work into another client's room irreversibly. More
 * than one candidate and no active room set means stay quiet.
 */
export const statusRoom = (rooms, active) =>
  rooms.find((r) => r.group && r.group === active) ?? (rooms.length === 1 ? rooms[0] : null);

async function main() {
  let input = {};
  try { input = JSON.parse((await readStdin()) || "{}"); } catch {}
  if (input.stop_hook_active) return allowStop(); // loop cap reached -> stop

  const state = readState();
  if (state.watch !== true) return allowStop(); // paused (or no state file yet)

  // Claude Code passes the session's cwd on stdin; fall back to ours.
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const rooms = roomsOf(state).filter((r) => roomMatchesCwd(r, cwd));
  if (!rooms.length) return allowStop();

  const results = await Promise.all(rooms.map((r) => pollRoom(r)));
  noteDead(rooms, results);

  const { blocks, next, changed, anyNews } = collectFresh(rooms, results, state);
  if (changed) saveCursors(next);
  // Only something said keeps the agent going. Status lines ("X is working
  // on…") used to block the stop too, so every member's once-a-minute status
  // bought every other idle agent another model turn.
  if (!anyNews) return allowStop();

  const activeHint = state.active ? ` (your active room is "${state.active}")` : "";
  const reason =
    `📨 New Ping messages:\n` +
    `${blocks.join("\n")}\n\n` +
    `Reply with the ping_say tool${activeHint}. For your active room no extra args are needed; ` +
    `to reply in another room, pass its token shown above as room:"gm_…". If nothing is needed, you can stop.`;

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

// Which rooms have something new, formatted for injection — shared by the Stop
// hook (idle) and the PostToolUse hook (mid-task) so the two can never disagree
// about what counts as a new message or how a cursor moves.
export function collectFresh(rooms, results, state) {
  let changed = false;
  let anyFresh = false;
  let anyNews = false; // something other than status lines
  const blocks = [];
  const next = rooms.map((r) => ({ ...r }));

  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    const msgs = results[i];
    if (!Array.isArray(msgs)) continue; // failed poll, or a room that is gone

    if (!room.last_seen) {
      // First sight of this room: treat existing history as already seen.
      next[i].last_seen = msgs.reduce((a, m) => ((m.created_at || "") > a ? m.created_at : a), FLOOR);
      changed = true;
      continue;
    }
    // Open before anything reads the text: the @mention check and the injected
    // lines both need the plaintext, and the server only ever had ciphertext.
    const key = keyFrom(room.key);
    const fresh = msgs
      .filter((m) => m && m.mine === false && (m.created_at || "") > room.last_seen)
      .map((m) => (key ? { ...m, text: open(m.text, key) } : m));
    if (fresh.length) {
      next[i].last_seen = fresh.reduce((a, m) => (m.created_at > a ? m.created_at : a), room.last_seen);
      changed = true;
      anyFresh = true;
      if (fresh.some((m) => m.kind !== "log")) anyNews = true;
      // For a room that isn't the active one, hand the agent its token so it can
      // reply there via ping_say with room:"gm_…".
      const isActive = room.group && state.active && room.group === state.active;
      const hint = isActive ? "" : ` (reply here: ping_say with room:"${room.token}")`;
      // @mention: flag if any fresh message names me (my display name in this room).
      const mentioned = fresh.some((m) => mentionsMe(m.text, room.name));
      const flag = mentioned ? "🔔 " : "";
      const tag = mentioned ? " — you were @mentioned" : "";
      // A status post arrives on the same stream as chat, but it is not chat:
      // `[ana] edited useDM.ts` reads like ana typed that sentence at you.
      // Status lines: only each member's latest. A room's status stream is one
      // line a minute per member, and a backlog of them is noise, not news.
      const lastLog = new Map(fresh.filter((m) => m.kind === "log").map((m) => [m.from, m]));
      const lines = fresh.filter((m) => m.kind !== "log" || lastLog.get(m.from) === m).map((m) => {
        // Still sealed after opening: this machine has no key for the room, or
        // the wrong one. Say that, instead of pasting ciphertext at the agent.
        const text = /^ping-e2e:v\d+:/.test(String(m.text || ""))
          ? "🔒 encrypted, and this machine has no key for this room. Re-join with the whole invite link (the part after #k= is the key)."
          : m.text;
        // A log is a status line: what that agent did or is doing, in its words.
        if (m.kind === "log") return `    ⚙ ${m.from}: ${text}`;
        if (m.kind === "event") return `    • ${m.from} ${text}`;
        return `    [${m.from}] ${text}`;
      }).join("\n");
      blocks.push(`  ${flag}${room.group || "group"}${tag}${hint}:\n${lines}`);
    }
  }
  return { blocks, next, changed, anyFresh, anyNews };
}

// Merge only the cursors we advanced back into whatever state is on disk NOW.
// Writing our whole snapshot would erase a room another session joined while we
// were polling, and would resurrect watch:true after a concurrent /ping off.
export function saveCursors(next) {
  const cursors = new Map(next.filter((r) => r.last_seen).map((r) => [r.token, r.last_seen]));
  updateState((cur) => ({
    ...cur,
    rooms: roomsOf(cur).map((r) => (cursors.has(r.token) ? { ...r, last_seen: cursors.get(r.token) } : r)),
  }));
}

// Only run as a hook, not when something imports mentionsMe (e.g. selfcheck) —
// otherwise the import would poll rooms and process.exit() out from under it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
