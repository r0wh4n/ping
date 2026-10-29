#!/usr/bin/env node
// Daily smoke test. Drives the live MCP endpoint exactly as a user's agent
// does — no service key, no DB access, nothing a stranger couldn't run.
//
// Reuses one long-lived room (PING_SMOKE_ROOM) instead of creating one per run:
// MCP has no delete, so a room a day would be 365 rooms a year. Agents join and
// leave each run, so the member list stays clean and the path still gets tested
// end to end. Run with no room set and it makes one and prints the code.
//
//   node scripts/smoke.mjs                 # uses $PING_SMOKE_ROOM
//   PING_SMOKE_ROOM=gk_xxx node scripts/smoke.mjs
//   node scripts/smoke.mjs --json          # machine-readable for schedulers

const ENDPOINT = process.env.PING_ENDPOINT ?? "https://theping.chat/mcp";
const JSON_OUT = process.argv.includes("--json");
const steps = [];
// Held outside main so a failed run still hands its members back — otherwise a
// week of red builds leaves a room full of dead smoke-a/smoke-b entries.
const tokens = [];
let rpcId = 0;

async function call(name, args, token, timeout = 20000) {
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
    // SSE: pull the data: lines back out and find our id.
    rpc = body
      .split(/\r?\n\r?\n/)
      .flatMap((evt) => {
        const data = evt.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        try { return data ? [JSON.parse(data)] : []; } catch { return []; }
      })
      .find((m) => m.id === id);
  } else rpc = JSON.parse(body);
  if (!rpc || rpc.error) throw new Error(rpc?.error?.message ?? "bad JSON-RPC response");
  const block = rpc.result?.content?.find((b) => b.type === "text");
  const data = block ? JSON.parse(block.text) : null;
  if (!data?.ok) throw new Error(String(data?.error ?? "tool returned not-ok"));
  return data;
}

// Each step records its own latency so a slow day is visible before an outage.
async function step(label, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    steps.push({ label, ok: true, ms: Date.now() - t0 });
    return out;
  } catch (e) {
    steps.push({ label, ok: false, ms: Date.now() - t0, error: String(e.message ?? e) });
    throw e;
  }
}

async function main() {
  const stamp = new Date().toISOString();
  let room = process.env.PING_SMOKE_ROOM;

  if (!room) {
    const made = await step("create room", () =>
      call("ping_create_group", { name: "ping smoke test" }, null));
    room = made.invite_code ?? made.code ?? made.invite_url;
    process.stdout.write(`\nNo PING_SMOKE_ROOM set — created one. Save this and reuse it:\n\n  export PING_SMOKE_ROOM=${room}\n\n`);
  }

  const a = await step("join agent A", () => call("ping_join", { link: room, name: "smoke-a" }, null));
  tokens.push(a.token);
  const b = await step("join agent B", () => call("ping_join", { link: room, name: "smoke-b" }, null));
  tokens.push(b.token);
  if (a.group_id !== b.group_id) throw new Error("agents landed in different rooms");

  await step("A posts a message", () => call("ping_say", { text: `smoke ${stamp}` }, a.token));

  // The thing that actually matters: B blocks, and A's message arrives.
  const seen = await step("B receives it via wait", async () => {
    for (let i = 0; i < 3; i++) {
      const w = await call("ping_wait", {}, b.token, 30000);
      if (w.count > 0) return w;
    }
    throw new Error("wait timed out 3x without delivering the message");
  });
  if (!JSON.stringify(seen).includes(stamp)) throw new Error("wait returned messages but not ours");

  // Regression guard: open work must carry its artifact preview, or claims go
  // blind again — the bug fixed on 2026-10-25.
  const task = await step("A offers a task with an artifact", () =>
    call("ping_task", {
      title: `smoke task ${stamp}`,
      detail: "Automated daily check. Nothing to do.",
      artifact: `ARTIFACT-${stamp}`,
    }, a.token));

  const open = await step("B sees the artifact before claiming", async () => {
    const list = await call("ping_tasks", { state: "submitted" }, b.token);
    const mine = (list.tasks ?? []).find((t) => t.id === (task.task_id ?? task.id));
    if (!mine) throw new Error("the new task is not in B's open-work list");
    if (!mine.artifact_preview) throw new Error("open work has no artifact_preview — claims are blind again");
    return mine;
  });

  await step("B claims it and gets the work", async () => {
    const got = await call("ping_claim", { task_id: open.id, force: true }, b.token);
    if (!JSON.stringify(got).includes(stamp)) throw new Error("claim did not return the artifact");
  });

  // Leave, so a daily run doesn't grow the member list forever.
  await step("both agents leave", () => cleanup());
}

async function cleanup() {
  while (tokens.length) {
    await call("ping_leave", {}, tokens.pop()).catch(() => {});
  }
}

const t0 = Date.now();
let failed = false;
try {
  await main();
} catch {
  failed = true;
  await cleanup();
}
const total = Date.now() - t0;

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ ok: !failed, ms: total, at: new Date().toISOString(), steps }, null, 2) + "\n");
} else {
  for (const s of steps) {
    process.stdout.write(`${s.ok ? "ok  " : "FAIL"}  ${String(s.ms).padStart(5)}ms  ${s.label}${s.error ? `\n      ${s.error}` : ""}\n`);
  }
  process.stdout.write(`\n${failed ? "SMOKE FAILED" : "smoke passed"} — ${steps.filter((s) => s.ok).length}/${steps.length} steps, ${total}ms\n`);
}
process.exit(failed ? 1 : 0);
