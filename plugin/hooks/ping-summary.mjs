#!/usr/bin/env node
// Ping summary — Stop hook, run in the background (async).
//
// When the agent finishes a turn that did something, post one line to the room
// saying what was done, in plain words: "created a tic-tac-toe game and a
// counting.txt file". The room used to hear what the filesystem could infer —
// "working on docs and the frontend" — which is true of building a game and of
// deleting one, and told teammates nothing.
//
// The line is written by a small model (Haiku, through the person's own Claude
// Code) from the request, the tools the agent used and its final reply, and is
// sealed with the room key before it leaves the machine. Turns that only talked
// (no tools), or only used Ping itself, post nothing. Off with /ping status off.

import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readState, updateState, roomsOf, roomMatchesCwd, VERSION } from "./ping-state.mjs";
import { API, ANON, readStdin, statusRoom } from "./ping-watch.mjs";
import { keyFrom, seal } from "./ping-crypto.mjs";
import { taskFrom, commitSubject } from "./ping-activity.mjs";
import { redact } from "./ping-adapter.mjs";

const isPing = (name) => /^mcp__.*ping/i.test(String(name));
// Bookkeeping, not work: looking up a tool, a plan, a todo list, a question to
// the person. A turn made only of these (plus Ping) reports nothing.
const META = new Set(["ToolSearch", "Skill", "TodoWrite", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
  "ReadNotifications", "TaskStop", "TaskOutput", "Monitor", "ScheduleWakeup", "SendFeedback", "SendUserFile",
  "ListAgents", "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]);

// One short label per tool call: what Haiku needs to say what happened, and
// nothing it could repeat that should not leave the machine.
export function actionOf(p) {
  const i = p?.input ?? {};
  const file = (f) => (typeof f === "string" ? basename(f) : "");
  switch (p?.name) {
    case "Write": return `wrote ${file(i.file_path)}`;
    case "Edit": case "MultiEdit": return `edited ${file(i.file_path)}`;
    case "NotebookEdit": return `edited ${file(i.notebook_path)}`;
    case "Read": return `read ${file(i.file_path)}`;
    case "Grep": case "Glob": return "searched the code";
    case "WebSearch": return `searched the web: ${String(i.query ?? "").slice(0, 80)}`;
    case "WebFetch": { try { return `read ${new URL(i.url).hostname}`; } catch { return "read a web page"; } }
    case "Bash": {
      // A commit says what the work was in its subject; keep that, not the
      // first 80 characters of a heredoc.
      const subject = commitSubject(String(i.command ?? ""));
      if (subject) return `committed: ${redact(subject).slice(0, 120)}`;
      return `ran: ${redact(String(i.command ?? "")).replace(/\s+/g, " ").slice(0, 80)}`;
    }
    case "Task": case "Agent": return `delegated: ${String(i.description ?? "").slice(0, 80)}`;
    default: return p?.name ? `used ${String(p.name).replace(/^mcp__/, "").slice(0, 40)}` : "";
  }
}

/** The turn since `since`: what was asked, and what the agent did. */
export function turnOf(lines, since) {
  let task = null, until = since || "";
  const actions = [];
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o?.timestamp || (since && o.timestamp <= since)) continue;
    if (o.timestamp > until) until = o.timestamp;
    if (o.type === "user") {
      const t = taskFrom(o);
      // First summary in this session: only the latest request, not the
      // whole history before Ping was watching.
      if (t) { task = t; if (!since) actions.length = 0; }
      continue;
    }
    if (o.type !== "assistant") continue;
    for (const p of Array.isArray(o.message?.content) ? o.message.content : []) {
      if (p?.type === "tool_use" && !isPing(p.name) && !META.has(p.name)) actions.push(actionOf(p));
    }
  }
  return { task, actions: [...new Set(actions.filter(Boolean))].slice(0, 40), until };
}

// No model available: say what changed, by file name.
export function fallbackLine(actions) {
  const wrote = actions.filter((a) => a.startsWith("wrote ")).map((a) => a.slice(6));
  const edited = actions.filter((a) => a.startsWith("edited ")).map((a) => a.slice(7));
  const parts = [wrote.length && `wrote ${wrote.slice(0, 3).join(", ")}`, edited.length && `edited ${edited.slice(0, 3).join(", ")}`].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

// The Actions are the evidence. The final reply is context only: it often
// reports what OTHER agents did ("the EC2 built the calculator") or what was
// merely found, and a summary built from it claimed that work for this agent —
// "Rohan (Mac): created a calculator.html…", which the Mac never did.
export const PROMPT = (task, actions, reply) =>
  "Write a status line for a teammate's activity feed saying what THIS coding agent itself just did.\n" +
  "The Actions list is the only evidence of what it did. The request and final reply are context: the reply may describe " +
  "work done by other people or other agents, or things it only found or checked — never claim those as its own. " +
  "If the Actions only read, searched or ran checks, say what it looked into (e.g. \"checked what teammates are working on\"). " +
  "Say something was created, changed or deleted only if an Action shows it.\n" +
  "Rules: one line, at most 14 words, past tense, start lowercase, no trailing period. " +
  "Plain words, e.g. \"created a tic-tac-toe game and a counting.txt text file\", \"researched 5 security advisories\", " +
  "\"fixed the login redirect bug\". Never include secrets, keys, tokens, passwords, emails, folder paths or code. " +
  "If nothing was done, reply exactly NONE. Reply with only the line.\n\n" +
  `Request: ${task ?? "(none)"}\nActions:\n- ${actions.join("\n- ")}\n` +
  `Agent's final reply: ${String(reply ?? "").replace(/\s+/g, " ").slice(0, 1500)}`;

export function haiku(prompt) {
  return new Promise((resolve) => {
    // The prompt goes on stdin, not argv: on Windows `claude` may be a .cmd
    // that needs a shell, and a shell must never see this text. No tools, no
    // hooks, no MCP, run from the temp folder: it only writes one line.
    const child = spawn("claude", ["-p", "--model", "haiku", "--output-format", "text", "--tools", "",
      "--settings", JSON.stringify({ disableAllHooks: true }), "--strict-mcp-config"],
      { cwd: tmpdir(), shell: process.platform === "win32", stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? out.trim() : null); });
    child.stdin.end(prompt);
  });
}

export function cleanLine(raw) {
  const line = String(raw ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (!line || /^NONE\b/i.test(line) || line.length > 160) return null;
  return redact(line.replace(/^["'“”]+|["'“”.]+$/g, "")).trim() || null;
}

async function main() {
  let input = {};
  try { input = JSON.parse((await readStdin()) || "{}"); } catch {}
  const state = readState();
  if (state.status === false || state.watch === false || !input.transcript_path) return;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const room = statusRoom(roomsOf(state).filter((r) => roomMatchesCwd(r, cwd)), state.active);
  if (!room) return;

  const session = String(input.session_id || "default");
  const since = state.summary_until?.[session] ?? "";
  let lines;
  try { lines = (await readFile(input.transcript_path, "utf8")).trim().split("\n").slice(-1500); } catch { return; }
  const turn = turnOf(lines, since);
  const mark = (extra = {}) => updateState((s) => ({
    ...s, ...extra,
    // Last 50 sessions only; older cursors are never read again.
    summary_until: Object.fromEntries(Object.entries({ ...(s.summary_until ?? {}), [session]: turn.until }).slice(-50)),
  }));
  if (!turn.actions.length) return mark(); // talked, or only used Ping: nothing to report

  const line = cleanLine(await haiku(PROMPT(turn.task, turn.actions, input.last_assistant_message))) ?? fallbackLine(turn.actions);
  if (!line || line === state.summary_text) return mark();
  const key = keyFrom(room.key);
  await new Promise((resolve) => execFile("curl", ["-s", "-X", "POST", API,
    "-H", `apikey: ${ANON}`, "-H", `Authorization: Bearer ${room.token}`,
    "-H", "Content-Type: application/json", "-H", `x-ping-plugin: ${VERSION}`,
    "-d", JSON.stringify({ action: "log", text: key ? seal(line, key) : line })], { timeout: 15000 }, () => resolve()));
  mark({ summary_text: line });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().finally(() => process.exit(0));
