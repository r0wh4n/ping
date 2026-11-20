// Shared by the hook adapters that report other agents' work to a Ping room
// (Codex and Command Code; see plugin/hooks/adapters/).
//
// An adapter is a short-lived process. The agent runs it on a hook event, it reads
// one JSON object on stdin, updates a small state file, posts at most two lines per
// turn and exits. Two rules hold everywhere in this file:
//   - Label-only. A post carries a label from the request ("building", "researching")
//     and an area ("the frontend") from file names. Prompt text, reply text, file
//     names and paths never leave this machine.
//   - Never write to stdout. Codex adds a hook's stdout to the agent's context, and
//     Command Code reads it as a decision.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, openSync, closeSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readState, roomsOf, roomMatchesCwd, VERSION } from "./ping-state.mjs";
import { keyFrom, seal } from "./ping-crypto.mjs";
import { describeWork } from "./ping-activity.mjs";

// The same public anon key and group API that ping-connect.mjs already ships.
export const API = "https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1/group-api";
export const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzZHNsa3hkb3F3c3BqZm96d3ZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5ODg3NjQsImV4cCI6MjEwMDU2NDc2NH0.Kuop6VvV3Ykak8SqH8yBJbt0H6N-mB2-riSVFQS7aDo";

// The verb in a request says what the work is for. Order matters: "research the
// news" must not read as "building", so research comes first.
const VERBS = [
  [/\b(research|news|search|look up|find out|tell me about)\b/i, "researching"],
  [/\b(create|build|make|add|implement|write|generate|scaffold)\b/i, "building"],
  [/\b(fix|bug|broken|error|debug|crash|failing)\b/i, "fixing"],
  [/\b(delete|remove|clean up)\b/i, "deleting"],
  [/\b(rename|move|refactor)\b/i, "reorganising"],
  [/\b(review|audit)\b/i, "reviewing"],
  [/\b(test|verify)\b/i, "testing"],
  [/\b(deploy|release|ship|publish)\b/i, "shipping"],
  [/\b(read|summar|explain|look at)\w*/i, "reading"],
];
export const classifyTask = (prompt) => (VERBS.find(([re]) => re.test(prompt)) || [null, "working on a task"])[1];

// Strip pasted blocks, reminders and command wrappers before anything reads the text.
export const cleanPrompt = (text) =>
  String(text ?? "").replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

// A person's request is short and does not open with a heading. Agents run their own
// background turns through the same hook events (Codex's memory consolidation is a
// ~50 KB prompt that opens with a heading). Those must not be reported as work.
export const isHumanPrompt = (p) =>
  typeof p === "string" && p.length > 0 && p.length <= 2000 && !/^\s*#{1,6}\s/.test(p) && !/Memory Writing Agent/.test(p);

// Codex's apply_patch names the files it touches inside its command text.
export function patchPaths(command) {
  return [...String(command ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
}

// Command Code keeps the conversation in a JSONL transcript. The task is the latest
// user message that has text and no tool results. In interactive mode the file
// exists from the first moment of a turn; in print mode it appears only when the
// turn ends.
//
// The line number identifies the turn, not just the text: people send "continue"
// or "yes" more than once, and keying on text alone would silence every repeat.
export function transcriptTurn(path) {
  if (!path || !existsSync(path)) return null;
  let last = null;
  readFileSync(path, "utf8").split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type !== "message" || e.message?.role !== "user") return;
    const parts = Array.isArray(e.message.content) ? e.message.content : [];
    if (parts.some((p) => p?.type === "tool_result")) return;
    const text = cleanPrompt(parts.filter((p) => p?.type === "text").map((p) => p.text).join(" "));
    if (text) last = { text, index };
  });
  return last;
}
export const transcriptPrompt = (path) => transcriptTurn(path)?.text ?? null;

// What a tool call did to which files: created, wrote, edited or deleted. Names are
// returned here and only leave the machine at the "files" detail level and above.
const SHELL_TOOLS = new Set(["shell_command", "powershell", "Bash", "shell", "exec_command", "local_shell"]);
const PATCH_OPS = { Add: "created", Update: "edited", Delete: "deleted" };
const DELETE_VERBS = /^(rm|rmdir|unlink|del|erase|rd|remove-item|ri)$/i;

// Deletes usually go through a shell (rm, del, Remove-Item), never an edit tool, so
// a delete-only turn used to report no files at all.
export function deletedByShell(command) {
  const out = [];
  for (const seg of String(command ?? "").split(/&&|\|\||;|\||\n/)) {
    const words = seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    let i = /^sudo$/i.test(words[0] ?? "") ? 1 : 0;
    if (/^git$/i.test(words[i] ?? "") && /^rm$/i.test(words[i + 1] ?? "")) i += 2;
    else if (DELETE_VERBS.test(words[i] ?? "")) i += 1;
    else continue;
    for (const w of words.slice(i)) {
      if (w === "--" || /^-/.test(w) || /^\/[a-z]$/i.test(w)) continue; // -rf, -Force, --, /s /q
      // PowerShell lists several targets as one token: "a.html","b.html". Quotes come
      // off each name, not just the ends of the token, or a stray " reaches the room.
      for (const part of w.split(",")) {
        const name = part.replace(/^["'\s]+|["'\s]+$/g, "");
        if (name) out.push(name);
      }
    }
  }
  return out;
}

export function fileOps(toolName, toolInput) {
  if (toolName === "apply_patch") {
    return [...String(toolInput?.command ?? "").matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)]
      .map((m) => ({ op: PATCH_OPS[m[1]], path: m[2].trim() }));
  }
  if ((toolName === "write_file" || toolName === "edit_file") && typeof toolInput?.file_path === "string") {
    return [{ op: toolName === "write_file" ? "wrote" : "edited", path: toolInput.file_path }];
  }
  if (SHELL_TOOLS.has(toolName)) {
    const c = toolInput?.command;
    const cmd = [Array.isArray(c) ? c.join(" ") : c, ...(Array.isArray(toolInput?.args) ? toolInput.args : [])]
      .filter((x) => typeof x === "string").join(" ");
    return deletedByShell(cmd).map((path) => ({ op: "deleted", path }));
  }
  return [];
}

// File names only, grouped by what happened, capped. Never a directory: a path
// says where someone keeps their work, and often whose work it is.
const nameOf = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? String(p);
export function opsSummary(ops, max = 4) {
  const groups = new Map();
  for (const { op, path } of ops) {
    const n = nameOf(path);
    if (!groups.has(op)) groups.set(op, []);
    if (!groups.get(op).includes(n)) groups.get(op).push(n);
  }
  let shown = 0;
  let hidden = 0;
  const parts = [];
  for (const [op, names] of groups) {
    const take = names.slice(0, Math.max(0, max - shown));
    hidden += names.length - take.length;
    shown += take.length;
    if (take.length) parts.push(`${op} ${take.join(", ")}`);
  }
  return parts.length ? parts.join("; ") + (hidden ? ` +${hidden} more` : "") : null;
}

// Requests carry secrets: one in this project's own history pasted a password and
// an API key. At the "task" level, keyword-introduced values, credentialed URLs and
// long key-shaped strings are removed before anything is posted.
export function redact(text) {
  return String(text ?? "")
    .replace(/\b(password|passwd|pwd|passcode|token|secret|api[\s_-]?key)\b(\s*(?:is|=|:|-)?\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi, "[redacted]@")
    .replace(/[A-Za-z0-9_\-]{24,}/g, "[redacted]");
}

export function firstSentence(text, max = 110) {
  const s = String(text ?? "").split(/(?<=[.!?])\s/)[0].trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max / 2 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

// How much of their own work a person shares, chosen per room on their machine with
// /ping detail. Labels unless they have said otherwise.
export const DETAIL_LEVELS = ["labels", "files", "task"];
export const detailOf = (room) => (DETAIL_LEVELS.includes(room?.detail) ? room.detail : "labels");

export const startedLine = (client, label, task, detail) =>
  `${client} · started: ${label}` + (detail === "task" && task ? ` — "${task}"` : "");

export function finishedLine(client, label, ops, detail) {
  const tail = detail === "labels" ? describeWork(ops.map((o) => o.path)) : opsSummary(ops);
  return `${client} · finished: ${label}` + (tail ? ` · ${tail}` : "");
}

// One "op<TAB>path" line per file a tool call touched. A line with no tab came from
// the previous version, which recorded edits only.
export const readOps = (file) =>
  readLines(file).map((l) => {
    const tab = l.indexOf("\t");
    return tab < 0 ? { op: "edited", path: l } : { op: l.slice(0, tab), path: l.slice(tab + 1) };
  });

// The room this work belongs to: a room scoped to this directory, preferring the
// active one. PING_ADAPTER_ROOM picks a room by name, for tests and for people in
// several rooms who want a fixed one.
export function pickRoom(cwd) {
  const state = readState();
  if (process.env.PING_ADAPTER_ROOM) return roomsOf(state).find((r) => r.group === process.env.PING_ADAPTER_ROOM) ?? null;
  const rooms = roomsOf(state).filter((r) => roomMatchesCwd(r, cwd));
  return rooms.find((r) => r.group && r.group === state.active) ?? rooms[0] ?? null;
}

export async function postLine(room, text) {
  // PING_ADAPTER_DRYRUN names a file to append to instead of posting. Tests use it
  // to count lines without filling a real room.
  if (process.env.PING_ADAPTER_DRYRUN) return appendLine(process.env.PING_ADAPTER_DRYRUN, text);
  const key = keyFrom(room.key);
  await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON, authorization: `Bearer ${room.token}`, "x-ping-plugin": VERSION },
    body: JSON.stringify({ action: "log", text: key ? seal(text, key) : text }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
}

// Per-turn state lives under ~/.ping/adapters/<client>/ and holds only a label and
// the file names that were touched. It is removed when the turn ends; the small
// started/finished markers are swept after a day.
export function turnFiles(client, key) {
  const base = join(homedir(), ".ping", "adapters", client, String(key).replace(/[^A-Za-z0-9_-]/g, "_"));
  return { label: base + ".json", paths: base + ".paths", started: base + ".started", finished: base + ".finished" };
}
export const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
export function writeJson(f, v) {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(v));
}
export function dropFile(f) {
  try { unlinkSync(f); } catch { /* already gone */ }
}

// Hooks for one event can run in parallel: Command Code runs PostToolUse hooks
// concurrently, and Codex launches every matching hook at once. "Read the state,
// then post" let two of them post the same started line a second apart in a live
// room. Creating a marker with the exclusive flag is atomic, so exactly one
// process wins and the rest stay quiet.
export function claimOnce(path) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, "wx"));
    return true;
  } catch {
    return false; // already claimed, or unwritable: either way, never post twice
  }
}

// Appending one short line is safe from parallel processes. Rewriting a JSON list
// is not: a concurrent read-modify-write drops the other process's entry.
export function appendLine(path, line) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n");
}
export const readLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);

export function sweep(client, maxAgeMs = 24 * 60 * 60 * 1000) {
  const dir = join(homedir(), ".ping", "adapters", client);
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const f = join(dir, name);
    try { if (Date.now() - statSync(f).mtimeMs > maxAgeMs) unlinkSync(f); } catch { /* raced with another sweep */ }
  }
}
