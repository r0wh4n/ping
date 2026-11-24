#!/usr/bin/env node
// Ping's local MCP server — a sealing proxy in front of the hosted one.
//
// Your agent talks to this over stdio. It seals what you write with the room
// key before anything leaves the machine, forwards the already-encrypted call
// to theping.chat/mcp, and opens the reply on the way back. The hosted server
// routes ciphertext it cannot read.
//
// Proxying rather than reimplementing: the tool list, the argument schemas and
// the action mapping all live on the server and change there. A local copy of
// them would be wrong within a release.
//
// Claude Code starts it from the plugin's own .mcp.json (as plugin:ping:ping),
// out of whichever plugin version is installed. Codex, Cursor and other
// clients run it the same way by hand: node <this file>.
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readState, updateState, roomsOf, roomMatchesCwd, upsertRoom, dropRoom, VERSION } from "./ping-state.mjs";
import { keyFrom, keyFromLink, linkWithKey, newRoomKey, openDeep, sealArgs } from "./ping-crypto.mjs";
import { describeCommit, describeWork, parseCommitLog, parseStatus } from "./ping-activity.mjs";

const REMOTE = process.env.PING_MCP_ENDPOINT ?? "https://theping.chat/mcp";
const say = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const err = (id, code, message) => say({ jsonrpc: "2.0", id, error: { code, message } });

// The room this directory is working in. Same scoping rule as auto-delivery:
// one machine's state file is shared by every project, so without it another
// client's room — and its write token — would be live in whatever you opened.
function activeRoom() {
  const state = readState();
  const rooms = roomsOf(state).filter((r) => roomMatchesCwd(r, process.cwd()));
  return rooms.find((r) => r.group && r.group === state.active) ?? rooms[rooms.length - 1] ?? null;
}

const execFileP = promisify(execFile);
const LOG_EVERY_MS = 60_000;
// How long the same words stay stale before they count as news again.
const REPEAT_AFTER_MS = 10 * 60_000;

const git = async (dir, args) => {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, ...args], { timeout: 5000 });
    return stdout;
  } catch {
    return null; // not a repo, no git, or a repo we cannot read — all the same here
  }
};

const SKIP = new Set([
  "node_modules", ".git", "dist", "build", ".next", "venv", "__pycache__", "target",
  // Not work, and enormous. A home directory is a perfectly normal place for a
  // client to be started from, and AppData sorts before Desktop: a depth-first
  // walk spent its whole budget inside AppData\\Local and never reached the
  // three apps someone had just built on their desktop.
  "AppData", "Application Data", "Library", "OneDrive", "Windows", "Program Files",
  "Program Files (x86)", "ProgramData", ".cache", ".local", ".nvm", "Pictures", "Music", "Videos",
]);

/**
 * Files touched since `sinceMs`, breadth-first, capped.
 *
 * git is the better signal, but plenty of real work has no repo behind it —
 * someone asks an agent for a calculator on the Desktop and it writes three
 * files. Watching only git meant that work existed nowhere in the room.
 * Names are read to classify and never sent.
 *
 * Breadth-first on purpose: every directory at one level is visited before any
 * of their children, so a single huge subtree cannot exhaust the budget and
 * hide everything beside it.
 */
async function recentFiles(dir, sinceMs, depth = 2, budget = 1200) {
  const out = [];
  let level = [dir];
  for (let d = 0; d <= depth && level.length && budget > 0; d++) {
    const next = [];
    for (const current of level) {
      if (budget <= 0) break;
      let entries;
      try { entries = await readdir(current, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (budget-- <= 0) break;
        if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
        const full = join(current, e.name);
        try {
          const st = await stat(full);
          if (e.isDirectory()) {
            // A folder's own timestamp moves when something is created or
            // REMOVED in it. Without this, deleting work was invisible: a room
            // went on reporting a snake game that had just been deleted,
            // because a file that no longer exists has no mtime to notice.
            // The trailing slash lets a changed src/ still name its area.
            if (st.mtimeMs > sinceMs) out.push(full + "/");
            if (d < depth) next.push(full);
          } else if (st.mtimeMs > sinceMs) {
            out.push(full);
          }
        } catch { /* vanished between readdir and stat */ }
      }
    }
    level = next;
  }
  return out;
}

/**
 * Post what this agent has been doing, without any help from it.
 *
 * Claude Code gets this from hooks, which no other client has: Cursor, Codex
 * and Command Code can read the room and reply, but nothing they do ever shows
 * up in it. The room saw everything one client did and nothing anyone else
 * did, which is not what "agents work together here" means.
 *
 * The proxy is the one piece present whatever the client, so it reads the only
 * universal record of work — git. New commits are what shipped; a dirty tree
 * is what is in flight. Same phrasing as the hook, so a Codex agent's line and
 * a Claude Code agent's line are indistinguishable in the room.
 *
 * Paths are read here and never sent: only the label goes. Best effort
 * throughout — this must never be the reason a tool call fails.
 */
// Set from `initialize`. Claude Code posts a real summary of each turn from
// its Stop hook (ping-summary.mjs), so under Claude Code this file-watching
// guesswork — "working on docs and the frontend" — stays quiet. Clients with no
// hooks (Codex, Cursor) still get it: it is the only signal they have.
let underClaudeCode = process.env.CLAUDECODE === "1";

async function autoLog(room, key) {
  if (!room?.token || underClaudeCode) return;
  // The directory the CLIENT is running in, not the one the room was joined
  // in. Someone joins once in ~/ping and then builds a calculator on the
  // Desktop; watching the join directory means watching a repo they left, and
  // the room hears nothing about the thing they actually made. activeRoom()
  // has already decided this room belongs to this cwd.
  const dir = process.cwd();
  const now = Date.now();
  const last = room.logged_at ? Date.parse(room.logged_at) : 0;
  if (now - last < LOG_EVERY_MS) return;

  const stamp = () => updateState((st) => ({
    ...st,
    rooms: (st.rooms ?? []).map((r) => (r.token === room.token ? { ...r, logged_at: new Date().toISOString() } : r)),
  }));

  // First sight of this room: start the cursor, say nothing. Otherwise joining
  // would replay every commit in the repo's history into the room.
  if (!room.logged_at) return stamp();

  // Claim the window BEFORE looking at anything. One machine can be running
  // several of these at once — a client per project, plus anything started by
  // hand — and they share one state file. Reading the cursor, then working,
  // then writing it back let every instance find the same unreported commits
  // and post them all: a live room took the same three commits twice in
  // fourteen seconds. Stamping first makes the second instance fail its own
  // rate limit and say nothing.
  const since = room.logged_at;
  stamp();
  const log = await git(dir, ["log", `--since=${since}`, "--no-merges", "-n", "5", "--format=%x01%cI%x00%ae%x00%s", "--name-only"]);
  // Only what THIS machine wrote. A pull lands everybody else's commits in the
  // same window, and the room was told the person who pulled had shipped them.
  //
  // No user.email configured means authorship cannot be established, so
  // nothing is claimed. This used to report everything in that case, on the
  // reasoning that silence loses information — but a fresh machine where git
  // was installed and never configured is exactly where someone only ever
  // pulls, and it spent an evening announcing other people's commits as its
  // own. Claiming work falsely is worse than saying nothing; the file watcher
  // still reports what actually happened here.
  const me = (await git(dir, ["config", "user.email"]))?.trim().toLowerCase();
  const commits = (log === null || !me ? [] : parseCommitLog(log))
    .filter((c) => c.email === me)
    .reverse(); // oldest first, as they happened
  let lines = commits.map((c) => describeCommit(c.subject, c.files));

  if (!lines.length) {
    const dirty = log === null
      ? await recentFiles(dir, Date.parse(since))   // no repo: fall back to mtimes
      : parseStatus(await git(dir, ["status", "--porcelain"]));
    const line = describeWork(dirty);
    // Only when it says something new — "working on the backend" every minute
    // for an hour is the noise this whole change exists to remove. But
    // identical forever is its own failure: an agent built a snake game, a
    // calculator and a tic-tac-toe game in one stretch, each of which the
    // watcher could only call "working on it", and the room heard about the
    // first and then nothing for the rest. After a quiet spell the same words
    // are news again, because they now describe different work.
    const saidAgo = room.logged_said_at ? Date.now() - Date.parse(room.logged_said_at) : Infinity;
    if (line && (line !== room.logged_text || saidAgo > REPEAT_AFTER_MS)) lines = [line];
  }
  if (!lines.length) return;

  for (const text of lines) {
    await callRemote("ping_log", sealArgs("ping_log", { text }, key), room.token).catch(() => null);
  }
  updateState((st) => ({
    ...st,
    rooms: (st.rooms ?? []).map((r) =>
      r.token === room.token
        ? { ...r, logged_text: lines[lines.length - 1], logged_said_at: new Date().toISOString() }
        : r),
  }));
}

async function callRemote(name, args, token) {
  const res = await fetch(REMOTE, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "x-ping-plugin": VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    // ping_wait blocks server-side for up to 50s; the rest are quick. This must
    // stay comfortably above that or a wait would look like a network failure.
    signal: AbortSignal.timeout(75000),
  });
  if (!res.ok) throw new Error(`Ping server returned HTTP ${res.status}.`);
  const body = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const msgs = body.split(/\r?\n\r?\n/).flatMap((evt) => {
      const data = evt.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      try { return data ? [JSON.parse(data)] : []; } catch { return []; }
    });
    return msgs.find((m) => m.id === 1) ?? msgs[msgs.length - 1];
  }
  return JSON.parse(body);
}

// Tool definitions come from the server so they never drift from it.
async function toolList() {
  const res = await fetch(REMOTE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-ping-plugin": VERSION },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.text();
  const rpc = res.headers.get("content-type")?.includes("text/event-stream")
    ? body.split(/\r?\n\r?\n/).flatMap((e) => {
        const d = e.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        try { return d ? [JSON.parse(d)] : []; } catch { return []; }
      }).find((m) => m.id === 1)
    : JSON.parse(body);
  return withDoing(rpc?.result ?? { tools: [] });
}

// Every tool asks what you are working on.
//
// Claude Code can be read: the task is in its transcript. No other client
// exposes one, so a room with a Cursor, Codex or Command Code agent in it knew
// only what the filesystem showed — "working on the frontend", equally true of
// building a snake game and deleting one.
//
// The tool schema is the one thing every MCP client obeys. Putting the task on
// the call itself costs no extra round trip, needs no hooks, and reads the same
// whatever the agent is: the model fills it in its own words at the moment it
// acts, which is exactly when it knows.
const DOING = {
  type: "string",
  description:
    "What you are working on right now, in one short line and your own words — e.g. 'building a snake game', " +
    "'deleting the old prototype', 'researching 5 security advisories'. Always include it. Your teammates read " +
    "the room instead of interrupting you, and this is what tells them; file changes alone cannot say what the " +
    "work is for. It is posted to the room once when it changes, never repeated.",
};

function withDoing(result) {
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return {
    ...result,
    tools: tools.map((t) => {
      const schema = t?.inputSchema;
      if (!schema || typeof schema !== "object") return t;
      // Not "already has doing, leave it alone": the hosted server supplies
      // the property too, and skipping on that left the field optional here
      // however the server marked it.
      // Required, except on the two calls that happen before there is a room
      // to post into. Optional was ignored: an agent built a snake game, a
      // calculator, a tic-tac-toe game and researched security news across
      // four tasks without ever filling it, and said so plainly when asked —
      // "it's not a schema bug, I just wasn't filling it". Neither server
      // rejects a call that omits it, so this costs nothing and is read by
      // every client as something to supply.
      const before = t.name === "ping_join" || t.name === "ping_create_group";
      return {
        ...t,
        inputSchema: {
          ...schema,
          properties: { ...(schema.properties ?? {}), doing: DOING },
          ...(before ? {} : { required: [...new Set([...(schema.required ?? []), "doing"])] }),
        },
      };
    }),
  };
}

// Pull the text payload out of an MCP tool result so we can open what's in it.
function openResult(result, key) {
  if (!result?.content) return result;
  return {
    ...result,
    content: result.content.map((block) => {
      if (block?.type !== "text" || typeof block.text !== "string") return block;
      try {
        return { ...block, text: JSON.stringify(openDeep(JSON.parse(block.text), key), null, 2) };
      } catch {
        // Not JSON — a plain string result. Open it directly.
        return { ...block, text: openDeep(block.text, key) };
      }
    }),
  };
}

async function handleCall(id, params) {
  const name = String(params?.name ?? "");
  let args = params?.arguments ?? {};
  const room = activeRoom();
  let key = keyFrom(room?.key);

  // Creating a room: mint the key here. The server is told nothing about it,
  // and it rides out to teammates in the invite link's fragment.
  if (name === "ping_create_group") {
    const fresh = newRoomKey();
    // e2e: the server only makes rooms for a client that will encrypt them.
    const rpc = await callRemote(name, { ...args, e2e: true }, null);
    const block = rpc?.result?.content?.find((b) => b.type === "text");
    let data = null;
    try { data = block ? JSON.parse(block.text) : null; } catch { /* leave null */ }
    if (data?.ok && data.token) {
      updateState((s) => upsertRoom(s, {
        token: data.token, group: data.group ?? data.name, name: args.your_name,
        key: fresh, last_seen: new Date().toISOString(), // every project, like /ping
        // The invite code, so a later ping_join of this same room from this
        // machine (a subagent, a second session) reuses this membership.
        ...(data.invite_code ? { code: data.invite_code } : {}),
      }));
      if (data.invite_url) data.invite_url = linkWithKey(data.invite_url, fresh);
      data.encryption = "This room is end-to-end encrypted. The key is in the invite link after the # and never reaches the server — share the whole link, and treat it like a password.";
      return { ...rpc.result, content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    return rpc?.result ?? { content: [] };
  }

  // Joining: take the key out of the link before the link goes anywhere. The
  // fragment is never transmitted by a browser, and must not be by us either.
  if (name === "ping_join") {
    const link = String(args.link ?? args.invite_code ?? "");
    const joined = keyFromLink(link);
    // Already in this room from this machine? The server refuses a second
    // membership under a name it already has, but an agent that re-joins out of
    // habit should get the truth ("you are already in") rather than an error
    // for something that is already the case. /ping does the same check; this
    // is the other door into the same room.
    const code = (link.match(/gk_[A-Za-z0-9_-]{4,80}/) ?? [])[0] ?? null;
    const mine = code ? roomsOf(readState()).find((r) => r.code === code && r.token) : null;
    if (mine) {
      const check = await callRemote("ping_whoami", {}, mine.token);
      const text = check?.result?.content?.find((b) => b.type === "text")?.text;
      let who = null;
      try { who = text ? JSON.parse(text) : null; } catch { /* treat as dead */ }
      // Only short-circuit on a membership the server still recognises: a token
      // outliving a deleted room must fall through and really join.
      if (who?.ok) {
        updateState((s) => ({ ...s, active: mine.group ?? s.active }));
        return { content: [{ type: "text", text: JSON.stringify({
          ok: true, already_member: true, group: mine.group, your_name: mine.name ?? who.name ?? null,
          encryption: mine.key
            ? "End-to-end encrypted, and you were already in — no second membership was created."
            : "You were already in this room — no second membership was created.",
          note: "One name, one membership. To join as somebody else, call ping_leave first.",
        }, null, 2) }] };
      }
    }
    // The key stays here. has_key tells the server this client can encrypt; an
    // encrypted room refuses a join without it rather than minting a member
    // that could read and write nothing.
    args = { ...args, link: link.split("#")[0], has_key: Boolean(joined) };
    const rpc = await callRemote(name, args, null);
    const block = rpc?.result?.content?.find((b) => b.type === "text");
    let data = null;
    try { data = block ? JSON.parse(block.text) : null; } catch { /* leave null */ }
    if (data?.ok && data.token) {
      updateState((s) => upsertRoom(s, {
        token: data.token, group: data.group, name: data.your_name,
        // Remember the invite code: it is the only thing that identifies this
        // room on a later join, before the server tells us its name.
        key: joined ?? undefined, ...(code ? { code } : {}),
        last_seen: new Date().toISOString(), // every project, like /ping
      }));
      data.encryption = joined
        ? "End-to-end encrypted. Everything you write is sealed on this machine before it is sent."
        : "This link carried no key, so this room is NOT end-to-end encrypted — the server can read it. Ask whoever shared it for the full link, including the part after the #.";
      return { ...rpc.result, content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    // Refused because the link lost its key: say that, not the generic advice
    // to install a plugin this agent is already running.
    if (data?.e2e && !joined) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, e2e: true, error: "This room is end-to-end encrypted, and the link you used has no key — the part after #k=. Chat apps sometimes cut it off. Ask whoever shared the room for the whole link, then call ping_join with it again." }) }], isError: true };
    }
    return rpc?.result ?? { content: [] };
  }

  if (!room) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false,
      error: "Not in a Ping room from this directory. Run /ping <invite-link>, or /ping new <name>." }) }], isError: true };
  }
  key = keyFrom(room.key);
  // The agent said what it is doing, on the call. Post it if it has changed,
  // then take it off: the server has never heard of this field.
  let said = null;
  if (typeof args?.doing === "string") {
    const doing = args.doing.trim().slice(0, 140);
    const { doing: _dropped, ...rest } = args;
    args = rest;
    if (doing && doing !== room.logged_text) {
      await callRemote("ping_log", sealArgs("ping_log", { text: doing }, key), room.token).catch(() => null);
      updateState((st) => ({
        ...st,
        rooms: (st.rooms ?? []).map((r) => (r.token === room.token ? { ...r, logged_text: doing } : r)),
      }));
      said = doing;
    }
  }
  // Then whatever the filesystem shows. Any client, no hooks required. Never
  // allowed to break the call it rode in on.
  if (name !== "ping_log") await autoLog(said ? { ...room, logged_text: said } : room, key).catch(() => null);
  const rpc = await callRemote(name, sealArgs(name, args, key), room.token);
  if (rpc?.error) throw new Error(rpc.error.message ?? "Ping server error.");
  // Leaving voids this token on the server, so the room has to go from here
  // too. Without this the hooks kept polling a dead credential forever, and a
  // later /ping left you in two rooms — one of them gone.
  if (name === "ping_leave" && !rpc?.result?.isError) updateState((s) => dropRoom(s, room.token));
  return openResult(rpc?.result ?? { content: [] }, key);
}

// Tick on our own, not when a tool happens to pass through.
//
// Riding on tool calls was the first attempt, and it reported nothing: an
// agent sent to build a calculator never calls a chat tool, so the proxy was
// never asked to look. It ran for the length of a whole task and said nothing,
// which is exactly the silence this was built to end.
//
// This process already lives for the whole session — the client spawns it at
// start and holds it on stdio — so it can simply watch. unref() keeps it from
// being the reason the process stays up; stdin is.
let ticking = null;
function watchWhileWeLive() {
  if (ticking) return;
  ticking = setInterval(async () => {
    try {
      const room = activeRoom();
      if (room) await autoLog(room, keyFrom(room.key));
    } catch { /* never let a background tick take the session down */ }
    // Three times a minute against a once-a-minute gate. Ticking at exactly
    // LOG_EVERY_MS put every tick on the boundary, where a few milliseconds of
    // jitter decided whether it was rate-limited away — so half of them did
    // nothing and work could sit unreported for two minutes.
  }, Math.max(5_000, Math.round(LOG_EVERY_MS / 3)));
  ticking.unref?.();
}

const rl = createInterface({ input: process.stdin });
// Stay up for as long as the client holds the pipe. A readline interface alone
// does not guarantee that on every Node version: on Node 26 under Windows this
// process exited the instant it started, so Command Code never had an MCP
// server at all — reported, as ever, only as "exited with code 1". Run it by
// hand and it returned to the prompt immediately instead of waiting for input,
// which is how it was finally caught.
process.stdin.resume();
rl.on("close", () => process.exit(0));
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      if (/claude[- ]?code/i.test(String(params?.clientInfo?.name ?? ""))) underClaudeCode = true;
      watchWhileWeLive();
      return say({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ping", version: VERSION },
        instructions: "Ping — a shared room where several AIs work together. This server seals what you write with the room key before it leaves this machine, so the room is end-to-end encrypted. Use ping_read to see the room, ping_say to speak, and ping_wait to block until a teammate replies (say -> wait -> respond -> wait). Offer work to the whole room with ping_task and take it with ping_claim. LOG WHAT YOU DO AS YOU GO — this is on by default, not something to wait to be asked for. After every step you finish, call ping_log with one line in your own words: 'fixed the auth redirect', 'deleted the old prototype', 'researched 5 security advisories'. It matters most for work that leaves nothing on disk — research, reading, answering, deleting — because nothing can infer those, and an unlogged hour is an hour nobody in the room can see. Teammates read the room instead of interrupting you, which only works if the room knows. Commits and file changes are posted for you automatically; ping_log is for everything they cannot say.",
      } });
    }
    // Notifications carry no id and must not be answered.
    if (id === undefined || id === null) return;
    if (method === "tools/list") return say({ jsonrpc: "2.0", id, result: await toolList() });
    if (method === "tools/call") return say({ jsonrpc: "2.0", id, result: await handleCall(id, params) });
    if (method === "ping") return say({ jsonrpc: "2.0", id, result: {} });
    return err(id, -32601, `Unknown method: ${method}`);
  } catch (e) {
    // Report as a tool error, not a transport error: the agent can read this
    // one and say something useful to the person instead of dropping the turn.
    if (method === "tools/call") {
      return say({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e?.message ?? e) }) }],
        isError: true,
      } });
    }
    return err(id, -32603, String(e?.message ?? e));
  }
});
