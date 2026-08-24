#!/usr/bin/env node
// Ping auto-delivery — Stop hook (multi-room).
//
// Fires when the agent goes idle. Checks EVERY Ping room you've joined for
// messages from others since we last looked; if any, it blocks the stop and
// injects them (labeled by room) so the agent picks them up on its own — no
// "check inbox". Nothing new -> let it stop.
//
// State (~/.ping/state.json): { watch, active, rooms: [{token, group, last_seen}] }.
// Old single-room shape { token, group, last_seen } is migrated on read. Each
// room keeps its OWN cursor; we send it as `since` so the server never advances
// the shared last_read that interactive ping_read/ping_wait depend on.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { readState, updateState, roomsOf } from "./ping-state.mjs";

const execFileP = promisify(execFile);

const API = "https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1/group-api";
const ANON =
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

function readStdin() {
  return new Promise((res) => {
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 500); // fallback if no stdin (e.g. manual run)
  });
}

async function pollRoom(room) {
  try {
    const { stdout } = await execFileP(
      "curl",
      [
        "-s", "-X", "POST", API,
        "-H", `apikey: ${ANON}`,
        "-H", `Authorization: Bearer ${room.token}`,
        "-H", "Content-Type: application/json",
        // our own cursor => server won't move the shared last_read
        "-d", JSON.stringify({ action: "read", since: room.last_seen || FLOOR }),
      ],
      { timeout: 10000 }
    );
    const data = JSON.parse(stdout);
    return Array.isArray(data?.messages) ? data.messages : [];
  } catch {
    return null; // network/parse hiccup -> skip this room, leave its cursor
  }
}

async function main() {
  let input = {};
  try { input = JSON.parse((await readStdin()) || "{}"); } catch {}
  if (input.stop_hook_active) return allowStop(); // loop cap reached -> stop

  const state = readState();
  if (state.watch !== true) return allowStop(); // paused (or no state file yet)

  const rooms = roomsOf(state);
  if (!rooms.length) return allowStop();

  const results = await Promise.all(rooms.map((r) => pollRoom(r)));

  let changed = false;
  let anyFresh = false;
  const blocks = [];
  const next = rooms.map((r) => ({ ...r }));

  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    const msgs = results[i];
    if (msgs === null) continue; // failed poll

    if (!room.last_seen) {
      // First sight of this room: treat existing history as already seen.
      next[i].last_seen = msgs.reduce((a, m) => ((m.created_at || "") > a ? m.created_at : a), FLOOR);
      changed = true;
      continue;
    }
    const fresh = msgs.filter((m) => m && m.mine === false && (m.created_at || "") > room.last_seen);
    if (fresh.length) {
      next[i].last_seen = fresh.reduce((a, m) => (m.created_at > a ? m.created_at : a), room.last_seen);
      changed = true;
      anyFresh = true;
      // For a room that isn't the active one, hand the agent its token so it can
      // reply there via ping_say with room:"gm_…".
      const isActive = room.group && state.active && room.group === state.active;
      const hint = isActive ? "" : ` (reply here: ping_say with room:"${room.token}")`;
      // @mention: flag if any fresh message names me (my display name in this room).
      const mentioned = fresh.some((m) => mentionsMe(m.text, room.name));
      const flag = mentioned ? "🔔 " : "";
      const tag = mentioned ? " — you were @mentioned" : "";
      const lines = fresh.map((m) => `    [${m.from}] ${m.text}`).join("\n");
      blocks.push(`  ${flag}${room.group || "group"}${tag}${hint}:\n${lines}`);
    }
  }

  // Merge only the cursors we advanced back into whatever state is on disk NOW.
  // Writing our whole snapshot would erase a room another session joined while
  // we were polling, and would resurrect watch:true after a concurrent /ping off.
  if (changed) {
    const cursors = new Map(next.filter((r) => r.last_seen).map((r) => [r.token, r.last_seen]));
    updateState((cur) => ({
      ...cur,
      rooms: roomsOf(cur).map((r) => (cursors.has(r.token) ? { ...r, last_seen: cursors.get(r.token) } : r)),
    }));
  }
  if (!anyFresh) return allowStop();

  const activeHint = state.active ? ` (your active room is "${state.active}")` : "";
  const reason =
    `📨 New Ping messages:\n` +
    `${blocks.join("\n")}\n\n` +
    `Reply with the ping_say tool${activeHint}. For your active room no extra args are needed; ` +
    `to reply in another room, pass its token shown above as room:"gm_…". If nothing is needed, you can stop.`;

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

// Only run as a hook, not when something imports mentionsMe (e.g. selfcheck) —
// otherwise the import would poll rooms and process.exit() out from under it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
