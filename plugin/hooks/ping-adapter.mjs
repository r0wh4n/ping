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
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readState, roomsOf, roomMatchesCwd, VERSION } from "./ping-state.mjs";
import { keyFrom, seal } from "./ping-crypto.mjs";

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
export function transcriptPrompt(path) {
  if (!path || !existsSync(path)) return null;
  let last = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "message" || e.message?.role !== "user") continue;
    const parts = Array.isArray(e.message.content) ? e.message.content : [];
    if (parts.some((p) => p?.type === "tool_result")) continue;
    const text = cleanPrompt(parts.filter((p) => p?.type === "text").map((p) => p.text).join(" "));
    if (text) last = text;
  }
  return last;
}

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
  const key = keyFrom(room.key);
  await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON, authorization: `Bearer ${room.token}`, "x-ping-plugin": VERSION },
    body: JSON.stringify({ action: "log", text: key ? seal(text, key) : text }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
}

// Per-turn state lives under ~/.ping, is deleted when the turn ends, and holds only a
// label and the file names that were touched.
export const stateFile = (client, key) =>
  join(homedir(), ".ping", "adapters", client, String(key).replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
export const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
export function writeJson(f, v) {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(v));
}
export function dropFile(f) {
  try { unlinkSync(f); } catch { /* already gone */ }
}
