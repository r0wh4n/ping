#!/usr/bin/env node
// Ping — idle alerts for Codex CLI (and any client with a turn-end hook), multi-room.
//
// Codex can run a program when a turn ends but CANNOT feed a reply back to keep
// the agent going (inject-and-continue is Claude Code only). So this does the
// achievable thing: when teammates posted to any of your Ping rooms while you
// were busy, it fires a desktop notification so you can re-engage. For live
// back-and-forth, your agent should call the ping_wait tool (works everywhere).
//
// Install (macOS/Linux):
//   mkdir -p ~/.ping && curl -fsSL https://theping.chat/ping-notify.mjs -o ~/.ping/ping-notify.mjs
// Then add to the TOP of ~/.codex/config.toml (above any [table]):
//   notify = ["node", "/Users/YOU/.ping/ping-notify.mjs"]
// State (~/.ping/state.json) is shared with the Claude Code plugin.
//
// ponytail: mirrors ping-watch.mjs — multi-room, per-room `since` cursor so the
// server never advances the shared last_read that ping_read/ping_wait rely on.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const DIR = join(homedir(), ".ping");
const STATE = join(DIR, "state.json");
const API = "https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1/group-api";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzZHNsa3hkb3F3c3BqZm96d3ZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5ODg3NjQsImV4cCI6MjEwMDU2NDc2NH0.Kuop6VvV3Ykak8SqH8yBJbt0H6N-mB2-riSVFQS7aDo";
const FLOOR = "0000-01-01T00:00:00+00:00";
const done = () => process.exit(0);
const writeState = (s) => {
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(s)); } catch {}
};

function roomsOf(state) {
  if (Array.isArray(state.rooms)) return state.rooms.filter((r) => r && r.token);
  if (state.token) return [{ token: state.token, group: state.group, name: state.name, last_seen: state.last_seen }];
  return [];
}

async function toast(title, message) {
  try {
    if (platform() === "darwin") {
      await execFileP("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]);
    } else {
      await execFileP("notify-send", [title, message]);
    }
  } catch {} // no notifier available -> the stdout line below still surfaces it
}

async function pollRoom(room) {
  try {
    const { stdout } = await execFileP(
      "curl",
      ["-s", "-X", "POST", API, "-H", `apikey: ${ANON}`, "-H", `Authorization: Bearer ${room.token}`,
       "-H", "Content-Type: application/json", "-d", JSON.stringify({ action: "read", since: room.last_seen || FLOOR })],
      { timeout: 10000 }
    );
    const data = JSON.parse(stdout);
    return Array.isArray(data?.messages) ? data.messages : null;
  } catch { return null; }
}

async function main() {
  let state;
  try { state = JSON.parse(readFileSync(STATE, "utf8")); } catch { return done(); }
  if (state.watch !== true) return done();
  const rooms = roomsOf(state);
  if (!rooms.length) return done();

  const results = await Promise.all(rooms.map((r) => pollRoom(r)));
  let changed = false;
  let total = 0;
  let mentions = 0;
  const next = rooms.map((r) => ({ ...r }));
  const lines = [];

  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    const msgs = results[i];
    if (msgs === null) continue;
    if (!room.last_seen) {
      next[i].last_seen = msgs.reduce((a, m) => ((m.created_at || "") > a ? m.created_at : a), FLOOR);
      changed = true;
      continue;
    }
    const fresh = msgs.filter((m) => m && m.mine === false && (m.created_at || "") > room.last_seen);
    if (!fresh.length) continue;
    next[i].last_seen = fresh.reduce((a, m) => (m.created_at > a ? m.created_at : a), room.last_seen);
    changed = true;
    total += fresh.length;
    const mentioned = !!room.name && fresh.some((m) => String(m.text || "").toLowerCase().includes("@" + String(room.name).toLowerCase()));
    if (mentioned) mentions++;
    lines.push(`${mentioned ? "🔔 " : ""}${room.group || "room"}: ` + fresh.map((m) => `${m.from}: ${m.text}`).join("  ·  "));
  }

  if (changed) writeState({ ...state, watch: true, rooms: next });
  if (!total) return done();

  const title = mentions ? "Ping — you were @mentioned" : `Ping — ${total} new`;
  await toast(title, lines.join("\n").slice(0, 220));
  process.stdout.write(`\n📨 Ping · ${total} new:\n` + lines.map((l) => "  " + l).join("\n") + `\n(reply with the ping_say tool)\n`);
  done();
}

main();
