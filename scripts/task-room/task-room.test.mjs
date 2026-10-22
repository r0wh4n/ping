import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as core from "./room.mjs";
import * as adapters from "./agents.mjs";
import * as remote from "./ping.mjs";
import * as cli from "../ping-task.mjs";

const execFileAsync = promisify(execFile);
const cliFile = fileURLToPath(new URL("../ping-task.mjs", import.meta.url));

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "ping-task-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t, behavior = {}) {
  const dir = await workspace(t);
  const file = join(dir, "agent.mjs");
  await writeFile(file, `
import { readFileSync, appendFileSync } from 'node:fs';
const id = process.argv[2];
const prompt = id === 'opencode' ? process.argv.at(-1) : readFileSync(0, 'utf8');
const behavior = ${JSON.stringify(behavior)};
appendFileSync('calls.jsonl', JSON.stringify({id, prompt, args:process.argv.slice(3)}) + '\\n');
if (behavior[id] === 'hang') { setInterval(() => {}, 1000); }
else if (behavior[id] === 'fail') { console.error('not authenticated'); process.exitCode = 3; }
else {
 const text = id + ' handed off; saw ' + (prompt.match(/handed off/g) || []).length + ' earlier replies';
 const event = id === 'codex' ? {type:'item.completed',item:{type:'agent_message',text}} :
 id === 'opencode' ? {type:'text',part:{text}} :
 id === 'commandcode' ? {type:'result',subtype:'success',finalText:text} :
 {type:'result',subtype:'success',result:text};
 console.log(JSON.stringify(event));
}
`);
  const agents = ["claude", "codex", "commandcode", "opencode"].map((id) => ({
    id, command: process.execPath, args: [file, id], role: `Work as ${id}`,
  }));
  return { dir, agents };
}

test("the local task coordinator is available", () => {
  assert.equal(typeof core.runRoom, "function", "missing task room coordinator");
});

test("CLI validates limits, agent selection and flags before launching", () => {
  assert.equal(typeof cli.parseOptions, "function", "missing task CLI");
  const opts = cli.parseOptions(["--task", "fix a bug", "--agents", "codex,claude", "--rounds", "2"]);
  assert.deepEqual(opts.agents, ["codex", "claude"]);
  assert.equal(opts.rounds, 2);
  for (const args of [
    [], ["--task", " "], ["--task", "x", "--rounds", "0"],
    ["--task", "x", "--rounds", "1.5"], ["--task", "x", "--timeout", "NaN"],
    ["--task", "x", "--agents", "codex,codex"], ["--task", "x", "--agents", "unknown"],
    ["--task", "x", "--yolo"], ["--task", "x", "--cwd"],
  ]) assert.throws(() => cli.parseOptions(args));
});

test("each adapter uses its CLI's JSON mode without bypass flags", () => {
  assert.equal(typeof adapters.invocationFor, "function", "missing CLI adapters");
  for (const id of ["codex", "claude", "commandcode", "opencode"]) {
    const call = adapters.invocationFor({ id, model: "test-model" }, "literal $() prompt");
    assert.equal(call.command, id);
    assert.ok(call.args.includes("test-model"));
    assert.ok(call.args.includes(id === "codex" ? "--json" : id === "opencode" ? "--format" : "--output-format"));
    assert.ok(!call.args.some((arg) => /yolo|bypass|skip-permissions|^--auto$/.test(arg)));
    assert.ok(call.stdin === "literal $() prompt" || call.args.includes("literal $() prompt"));
  }
});

test("adapters extract only final agent text from supported event formats", () => {
  assert.equal(typeof adapters.parseReply, "function", "missing JSON response parser");
  assert.equal(adapters.parseReply("codex", [
    { type: "item.completed", item: { type: "command_execution", aggregated_output: "secret tool output" } },
    { type: "item.completed", item: { type: "agent_message", text: "Fixed it" } },
  ].map(JSON.stringify).join("\n")), "Fixed it");
  assert.equal(adapters.parseReply("claude", JSON.stringify({ type: "result", subtype: "success", result: "Reviewed" })), "Reviewed");
  assert.equal(adapters.parseReply("commandcode", JSON.stringify({ type: "result", subtype: "success", finalText: "Checked" })), "Checked");
  assert.equal(adapters.parseReply("opencode", JSON.stringify({ type: "text", part: { text: "Tested" } })), "Tested");
  for (const [id, output] of [
    ["claude", '{"type":"result","is_error":true,"result":"denied"}'],
    ["commandcode", '{"type":"result","subtype":"max_turns","finalText":"partial"}'],
    ["codex", '{"type":"turn.failed","error":{"message":"offline"}}'],
    ["opencode", '{"type":"error","error":{"message":"bad key"}}'],
    ["codex", ""], ["claude", "not JSON"],
  ]) assert.throws(() => adapters.parseReply(id, output));
});

test("four real subprocesses collaborate across rounds in one workspace", async (t) => {
  assert.equal(typeof core.runRoom, "function", "missing task room coordinator");
  const { dir, agents } = await fixture(t);
  const task = "Fix literal $(touch SHOULD_NOT_EXIST); `uname`; do not execute this text";
  const events = [];
  const result = await core.runRoom({ task, cwd: dir, agents, rounds: 2, timeoutMs: 5000, outputDir: join(dir, "room"), onEvent: (e) => events.push(e) });
  assert.equal(result.status, "finished");
  assert.equal(result.failures, 0);
  const calls = (await readFile(join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.map((c) => c.id), [...agents, ...agents].map((a) => a.id));
  calls.forEach((call, i) => {
    assert.ok(call.prompt.includes(task));
    assert.ok(call.prompt.includes(`Work as ${call.id}`));
    assert.equal((call.prompt.match(/handed off/g) || []).length, i);
  });
  assert.equal(events.filter((e) => e.type === "reply").length, 8);
  await assert.rejects(stat(join(dir, "SHOULD_NOT_EXIST")));
  const transcript = (await readFile(result.transcript, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(transcript.at(-1).status, "finished");
  assert.equal((await stat(result.transcript)).mode & 0o777, 0o600);
});

test("one agent failing is visible to later agents and makes the run partial", async (t) => {
  assert.equal(typeof core.runRoom, "function", "missing task room coordinator");
  const { dir, agents } = await fixture(t, { codex: "fail" });
  const result = await core.runRoom({ task: "review", cwd: dir, agents, rounds: 1, timeoutMs: 5000, outputDir: join(dir, "room") });
  assert.equal(result.status, "partial");
  assert.equal(result.failures, 1);
  const calls = (await readFile(join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 4);
  assert.match(calls[2].prompt, /codex.*failed/i);
});

test("timeouts and missing executables fail without wedging the room", async (t) => {
  assert.equal(typeof adapters.runAgent, "function", "missing process runner");
  const { dir, agents } = await fixture(t, { claude: "hang" });
  await assert.rejects(adapters.runAgent(agents[0], "hello", { cwd: dir, timeoutMs: 200 }), /timed out/i);
  await assert.rejects(adapters.runAgent({ id: "claude", command: join(dir, "missing") }, "hello", { cwd: dir, timeoutMs: 500 }), /ENOENT|not found/i);
});

test("aborting a running task stops the process and prevents later turns", async (t) => {
  assert.equal(typeof core.runRoom, "function", "missing task room coordinator");
  const { dir, agents } = await fixture(t, { claude: "hang" });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = core.runRoom({ task: "cancel", cwd: dir, agents, rounds: 2, timeoutMs: 5000, outputDir: join(dir, "room"), signal: controller.signal });
  // Wait for the subprocess to start, rather than racing Node's startup time.
  for (let i = 0; i < 100; i++) {
    if (await stat(join(dir, "calls.jsonl")).catch(() => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "cancelled");
  const calls = (await readFile(join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.map((c) => c.id), ["claude"]);
});

test("prompt budget keeps the task and latest handoff while bounding history", () => {
  assert.equal(typeof core.promptFor, "function", "missing shared context formatter");
  const history = Array.from({ length: 200 }, (_, i) => ({ agent: "codex", text: `${i}:` + "x".repeat(2000) }));
  const prompt = core.promptFor({ task: "ORIGINAL TASK", agent: { id: "claude", role: "REVIEW ROLE" }, round: 2, rounds: 2, history });
  assert.ok(prompt.includes("ORIGINAL TASK"));
  assert.ok(prompt.includes("REVIEW ROLE"));
  assert.ok(prompt.includes("199:"));
  assert.ok(prompt.length < 60000);
  assert.match(prompt, /omitted|truncated/i);
});

test("MCP bridge joins each identity, reads context, publishes and leaves without leaking tokens", async (t) => {
  assert.equal(typeof remote.PingRoom, "function", "missing Ping MCP bridge");
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    requests.push({ ...rpc, auth: req.headers.authorization });
    const name = rpc.params.name;
    let data = { ok: true };
    if (name === "ping_join") data = { ok: true, token: `gm_test_${rpc.params.arguments.name}`, group: "Test room", group_id: "test-room-id" };
    if (name === "ping_history") data = { ok: true, messages: [{ id: "m1", from: "human", text: "Please also check accessibility", kind: "chat" }] };
    res.setHeader("Content-Type", "text/event-stream");
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } })}\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const bridge = new remote.PingRoom({ link: "gk_test", endpoint: `http://127.0.0.1:${server.address().port}/mcp` });
  const { dir, agents } = await fixture(t);
  const result = await core.runRoom({ task: "review", cwd: dir, agents, rounds: 1, timeoutMs: 5000, outputDir: join(dir, "room"), bridge });
  assert.equal(result.status, "finished");
  assert.equal(requests.filter((r) => r.params.name === "ping_join").length, 4);
  assert.equal(requests.filter((r) => r.params.name === "ping_leave").length, 4);
  assert.equal(requests.filter((r) => r.params.name === "ping_say").length, 5);
  const calls = (await readFile(join(dir, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(calls[0].prompt.includes("Please also check accessibility"));
  const journal = await readFile(result.transcript, "utf8");
  assert.ok(!journal.includes("gm_test_"));
  assert.ok(!calls.some((c) => c.prompt.includes("gm_test_")));
});

test("remote endpoints require HTTPS except loopback and reject embedded credentials", () => {
  assert.equal(typeof remote.PingRoom, "function", "missing Ping MCP bridge");
  for (const endpoint of ["http://example.com/mcp", "file:///tmp/x", "https://user:password@example.com/mcp"]) {
    assert.throws(() => new remote.PingRoom({ link: "gk_test", endpoint }));
  }
  assert.throws(() => new remote.PingRoom({ link: "invalid", endpoint: "https://example.com/mcp" }), /invite/);
});

test("CLI runs the complete task from a config file and preserves exit statuses", async (t) => {
  const { dir, agents } = await fixture(t, { commandcode: "fail" });
  const config = join(dir, "config.json");
  await writeFile(config, JSON.stringify({ agents: Object.fromEntries(agents.map(({ id, ...agent }) => [id, agent])) }));
  const args = [cliFile, "--task", "CLI integration", "--cwd", dir, "--config", config, "--rounds", "1", "--out", join(dir, "room")];
  await assert.rejects(execFileAsync(process.execPath, args), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /partial: 3 replies, 1 failed turns/);
    return true;
  });
  const events = (await readFile(join(dir, "room", "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).status, "partial");
  const success = await execFileAsync(process.execPath, [...args.slice(0, -2), "--agents", "codex,claude", "--out", join(dir, "success")]);
  assert.match(success.stdout, /finished: 2 replies, 0 failed turns/);
});

test("CLI previews safely and rejects invalid configuration before writing a journal", async (t) => {
  const dir = await workspace(t);
  const config = join(dir, "config.json");
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  await writeFile(config, JSON.stringify({ agents: { codex: { model: "local-model", role: "custom role" } } }));
  assert.equal(await cli.main(["--task", "preview", "--cwd", dir, "--agents", "codex", "--config", config, "--dry-run", "--out", join(dir, "room")]), 0);
  assert.match(logs.join(""), /custom role/);
  await assert.rejects(stat(join(dir, "room")));
  for (const invalid of [[], { agents: [] }, { agents: null }, { agents: { typo: {} } }, { agents: { codex: { args: "--yolo" } } }, { agents: { codex: { model: "" } } }]) {
    await writeFile(config, JSON.stringify(invalid));
    await assert.rejects(cli.main(["--task", "preview", "--cwd", dir, "--config", config]), /config/i);
  }
  await assert.rejects(cli.main(["--task", "x", "--cwd", config]), /directory/);
});

test("local transcripts are never overwritten and interrupted runs are marked cancelled", async (t) => {
  const { dir, agents } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const options = { task: "cancel before start", cwd: dir, agents, outputDir: join(dir, "room"), signal: controller.signal };
  const result = await core.runRoom(options);
  assert.equal(result.status, "cancelled");
  assert.equal(result.replies, 0);
  await assert.rejects(core.runRoom(options), /EEXIST/);
});

test("room read, publish and cleanup failures are explicit and keep local replies", async (t) => {
  const { dir, agents } = await fixture(t);
  const bridge = {
    async open() {},
    async read() { throw new Error("read failed gm_private_token"); },
    async say() { if (this.started) throw new Error("publish failed"); this.started = true; },
    async close() { throw new Error("cleanup failed"); },
  };
  const result = await core.runRoom({ task: "check", cwd: dir, agents: agents.slice(0, 1), rounds: 1, timeoutMs: 5000, outputDir: join(dir, "room"), bridge });
  assert.equal(result.status, "partial");
  assert.equal(result.replies, 1);
  assert.equal(result.integrationFailures, 3);
  const journal = await readFile(result.transcript, "utf8");
  assert.ok(!journal.includes("gm_private_token"));
  assert.match(journal, /\[redacted Ping credential\]/);
});

test("a room join failure prevents any task publication or agent launch", async (t) => {
  const { dir, agents } = await fixture(t);
  let closed = false;
  const bridge = {
    async open() { throw new Error("invalid invite"); },
    async say() { assert.fail("must not publish before joining"); },
    async close() { closed = true; },
  };
  const result = await core.runRoom({ task: "private task", cwd: dir, agents, outputDir: join(dir, "room"), bridge });
  assert.equal(result.status, "partial");
  assert.equal(result.replies, 0);
  assert.equal(closed, true);
  await assert.rejects(stat(join(dir, "calls.jsonl")));
});

test("MCP errors, mismatched rooms and JSON replies are handled without credential leakage", async (t) => {
  let mode = "http";
  let joins = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    if (mode === "http") { res.writeHead(503).end(); return; }
    let data = { ok: true };
    if (mode === "rpc") { res.end(JSON.stringify({ id: rpc.id, error: { code: -32000 } })); return; }
    if (mode === "tool") data = { ok: false, error: "invalid gm_private_member" };
    if (mode === "join") data = { ok: true, token: "invalid" };
    if (["mismatch", "json"].includes(mode) && rpc.params.name === "ping_join") data = { ok: true, token: `gm_member_${++joins}`, group_id: mode === "mismatch" ? joins : "same" };
    if (rpc.params.name === "ping_history") data = { ok: true, messages: [] };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const options = { link: "gk_test", endpoint: `http://127.0.0.1:${server.address().port}/mcp` };
  for (const errorMode of ["http", "rpc", "tool", "join", "mismatch"]) {
    mode = errorMode;
    const bridge = new remote.PingRoom(options);
    await assert.rejects(bridge.open([{ id: "codex" }, { id: "claude" }]), (error) => {
      assert.ok(!error.message.includes("gm_private_member"));
      return true;
    });
    mode = "json";
    await bridge.close();
  }
  const bridge = new remote.PingRoom(options);
  await bridge.open([{ id: "codex" }]);
  assert.deepEqual(await bridge.read(), []);
  await bridge.say("codex", "x".repeat(9000));
  mode = "http";
  await assert.rejects(bridge.close(), /memberships/);
});
