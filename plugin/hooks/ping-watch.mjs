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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const DIR = join(homedir(), ".ping");
const STATE = join(DIR, "state.json");
const API = "https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1/group-api";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzZHNsa3hkb3F3c3BqZm96d3ZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5ODg3NjQsImV4cCI6MjEwMDU2NDc2NH0.Kuop6VvV3Ykak8SqH8yBJbt0H6N-mB2-riSVFQS7aDo";
const FLOOR = "0000-01-01T00:00:00+00:00"; // sorts before any real timestamp

const allowStop = () => process.exit(0); // no stdout + exit 0 => agent stops normally
const writeState = (s) => {
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(s)); } catch {}
};

// Normalize any stored shape into a rooms array.
function roomsOf(state) {
  if (Array.isArray(state.rooms)) return state.rooms.filter((r) => r && r.token);
  if (state.token) return [{ token: state.token, group: state.group, last_seen: state.last_seen }];
  return [];
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

  let state;
  try { state = JSON.parse(readFileSync(STATE, "utf8")); } catch { return allowStop(); }
  if (state.watch !== true) return allowStop(); // paused

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
      const lines = fresh.map((m) => `    [${m.from}] ${m.text}`).join("\n");
      blocks.push(`  ${room.group || "group"}${hint}:\n${lines}`);
    }
  }

  if (changed) writeState({ ...state, watch: true, rooms: next });
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

main();
