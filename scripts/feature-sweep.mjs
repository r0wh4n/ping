#!/usr/bin/env node
// Exercises every Ping tool in one realistic run, against the live endpoint.
//
// Different job from smoke.mjs: smoke answers "is the product up?" in 30
// seconds and runs daily. This answers "does every feature still work?" and
// prints a transcript of a plausible two-agent session, which is also the
// material a demo is built from — the dialogue is real, not written for camera.
//
//   node scripts/feature-sweep.mjs            # readable transcript
//   node scripts/feature-sweep.mjs --json     # machine-readable results
//
// It creates its own room and deletes nothing, because MCP has no delete. Pass
// the room to a cleanup afterwards, or let it be: it names the room 'feature
// sweep' so it is obvious what it was.

const ENDPOINT = process.env.PING_ENDPOINT ?? "https://theping.chat/mcp";
const JSON_OUT = process.argv.includes("--json");
const results = [];
let rpcId = 0;

async function call(name, args, token, timeout = 30000) {
  const id = ++rpcId;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  let rpc;
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    rpc = body.split(/\r?\n\r?\n/).flatMap((evt) => {
      const d = evt.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      try { return d ? [JSON.parse(d)] : []; } catch { return []; }
    }).find((m) => m.id === id);
  } else rpc = JSON.parse(body);
  if (!rpc || rpc.error) throw new Error(rpc?.error?.message ?? "bad JSON-RPC");
  const block = rpc.result?.content?.find((b) => b.type === "text");
  const data = block ? JSON.parse(block.text) : null;
  if (!data?.ok) throw new Error(String(data?.error ?? "tool returned not-ok"));
  return data;
}

// `shows` is the one line a viewer should take away — what this tool is FOR,
// not what it returned. The transcript is read by people, not just diffed.
async function feature(tool, shows, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    results.push({ tool, shows, ok: true, ms: Date.now() - t0 });
    if (!JSON_OUT) process.stdout.write(`  ok   ${tool.padEnd(18)} ${shows}\n`);
    return out;
  } catch (e) {
    const error = String(e.message ?? e);
    results.push({ tool, shows, ok: false, ms: Date.now() - t0, error });
    if (!JSON_OUT) process.stdout.write(`  FAIL ${tool.padEnd(18)} ${shows}\n         ${error}\n`);
    return null;
  }
}

const transcript = [];
const scene = (who, what) => transcript.push({ who, what });

async function main() {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

  // --- Two agents meet in a room ----------------------------------------
  const room = await feature("ping_create_group", "one agent opens a room and gets a shareable link", () =>
    call("ping_create_group", { name: `feature sweep ${stamp}`, your_name: "backend-bot" }, null));
  if (!room) throw new Error("cannot continue without a room");
  const link = room.invite_code ?? room.invite_url;
  const alice = room.token;

  const bob = await feature("ping_join", "a second agent joins with nothing but that link — no account", () =>
    call("ping_join", { link, name: "frontend-bot" }, null));
  if (!bob) throw new Error("cannot continue without a second agent");

  await feature("ping_whoami", "an agent can ask which room it is in and who it is there", () =>
    call("ping_whoami", {}, bob.token));

  // --- They advertise what they can do ----------------------------------
  await feature("ping_card", "each agent publishes what it can take on, so work can be routed", async () => {
    await call("ping_card", { description: "Owns the API and the database schema.", skills: ["backend", "migrations", "api"] }, alice);
    return call("ping_card", { description: "Owns the web client.", skills: ["frontend", "react", "css"] }, bob.token);
  });

  const members = await feature("ping_members", "the room can be asked who is in it and what they do", () =>
    call("ping_members", {}, alice));

  // --- A real exchange ---------------------------------------------------
  const said = "Schema is live: users now has a deleted_at column. Soft deletes from here on.";
  await feature("ping_say", "one agent speaks to the whole room", () =>
    call("ping_say", { text: said }, alice));
  scene("backend-bot", said);

  const heard = await feature("ping_wait", "the other BLOCKS until that arrives — no polling, no human relaying", async () => {
    for (let i = 0; i < 3; i++) {
      const w = await call("ping_wait", {}, bob.token);
      if (w.count > 0) return w;
    }
    throw new Error("wait timed out without delivering");
  });
  if (heard && !JSON.stringify(heard).includes("deleted_at")) throw new Error("wait delivered the wrong message");

  const reply = "Got it — I'll filter deleted_at on the list view and ship it behind a flag.";
  await feature("ping_read", "reading marks the room caught up, so nothing is re-delivered", () =>
    call("ping_read", {}, bob.token));
  await call("ping_say", { text: reply }, bob.token);
  scene("frontend-bot", reply);

  // --- Durable context, separate from chat -------------------------------
  await feature("ping_share", "context is posted once and stays, instead of being re-explained", () =>
    call("ping_share", { room_name: room.group ?? room.name, title: "API base URL",
      text: "Staging API: https://staging.example.com/api/v2 — bearer auth, 60 req/min." }, alice));

  await feature("ping_log", "agents record what they did, which is what the recaps are built from", () =>
    call("ping_log", { title: "Migration applied", text: "Added users.deleted_at and backfilled 12k rows." }, alice));

  await feature("ping_history", "the full backlog is there for anyone who arrives late", () =>
    call("ping_history", { limit: 20 }, bob.token));

  await feature("ping_catchup", "a new agent gets briefed on the room instead of reading it all", () =>
    call("ping_catchup", {}, bob.token));

  await feature("ping_digest", "a day or week of work comes back as ticket-ready items", () =>
    call("ping_digest", { period: "week" }, alice));

  // --- The part a 1:1 protocol cannot do ---------------------------------
  const task = await feature("ping_task", "work is offered to the ROOM, carrying the thing it is about", () =>
    call("ping_task", {
      title: "Hide soft-deleted users in the list view",
      detail: "Rows with deleted_at set must not render. Keep the count accurate.",
      artifact: "GET /api/v2/users now returns deleted_at: string | null",
      skills: ["frontend"],
    }, alice));
  scene("backend-bot", "offers a task to the room: hide soft-deleted users");

  await feature("ping_tasks", "every agent sees the open work, and the material with it", () =>
    call("ping_tasks", { state: "submitted" }, bob.token));

  const claimed = await feature("ping_claim", "whichever agent is free takes it — atomically, no double work", () =>
    call("ping_claim", { task_id: task?.task_id ?? task?.id }, bob.token));
  scene("frontend-bot", "claims it — nobody had to assign it");

  await feature("ping_task_update", "and moves it through working → completed with a result", async () => {
    await call("ping_task_update", { task_id: task?.task_id ?? task?.id, state: "working" }, bob.token);
    return call("ping_task_update", { task_id: task?.task_id ?? task?.id, state: "completed",
      result: "Filtered on deleted_at, count now excludes them. Shipped behind flag soft_deletes." }, bob.token);
  });
  scene("frontend-bot", "done — result posted back to the room");

  // --- Control over the room ---------------------------------------------
  await feature("ping_invite", "the link can be rotated, so a leaked one stops working", () =>
    call("ping_invite", { op: "status" }, alice));

  await feature("ping_leave", "an agent leaves and its credential dies with it", () =>
    call("ping_leave", {}, bob.token));

  return { room: room.group ?? room.name, link: room.invite_url ?? link, claimed: Boolean(claimed) };
}

let info = null;
let fatal = null;
try {
  if (!JSON_OUT) process.stdout.write("\nPing feature sweep — every tool, one session\n\n");
  info = await main();
} catch (e) {
  fatal = String(e.message ?? e);
}

const passed = results.filter((r) => r.ok).length;
if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ ok: !fatal && passed === results.length, passed, total: results.length, fatal, info, results, transcript }, null, 2) + "\n");
} else {
  process.stdout.write(`\n${passed}/${results.length} tools working${fatal ? ` — STOPPED: ${fatal}` : ""}\n`);
  if (info) process.stdout.write(`room: ${info.room}\nlink: ${info.link}\n`);
  process.stdout.write("\nWhat a viewer would see:\n");
  for (const t of transcript) process.stdout.write(`  ${t.who}: ${t.what}\n`);
  process.stdout.write("\n");
}
process.exit(fatal || passed !== results.length ? 1 : 0);
