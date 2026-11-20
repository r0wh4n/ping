#!/usr/bin/env node
// Codex hook adapter: reports a person's Codex work to their Ping room.
//
// Wire it in ~/.codex/hooks.json under UserPromptSubmit, PostToolUse and Stop. Codex
// asks you to review and trust each hook once, and that review is deliberate. How
// much is shared is chosen with /ping detail (labels by default).
import { readFileSync } from "node:fs";
import {
  pickRoom, classifyTask, cleanPrompt, isHumanPrompt, redact, firstSentence, fileOps, postLine,
  detailOf, startedLine, finishedLine, turnFiles, readJson, writeJson, dropFile, claimOnce, appendLine, readOps, sweep,
} from "../ping-adapter.mjs";

const CLIENT = "Codex";
// Unreadable input means nothing to report. A crash would surface in the agent's UI
// as a hook error over something the person cannot fix.
let input;
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }
if (!input.turn_id) process.exit(0);
const f = turnFiles("codex", input.turn_id);

if (input.hook_event_name === "UserPromptSubmit") {
  const prompt = cleanPrompt(input.prompt);
  if (!isHumanPrompt(prompt)) process.exit(0); // Codex's own background agents use this event too
  const label = classifyTask(prompt);
  const task = firstSentence(redact(prompt));
  writeJson(f.label, { label, task });
  if (claimOnce(f.started)) {
    const room = pickRoom(input.cwd);
    if (room) await postLine(room, startedLine(CLIENT, label, task, detailOf(room)));
  }
} else if (input.hook_event_name === "PostToolUse") {
  if (readJson(f.label)) for (const o of fileOps(input.tool_name, input.tool_input)) appendLine(f.paths, `${o.op}\t${o.path}`);
} else if (input.hook_event_name === "Stop") {
  const st = readJson(f.label);
  if (st && claimOnce(f.finished)) {
    const room = pickRoom(input.cwd);
    if (room) await postLine(room, finishedLine(CLIENT, st.label, readOps(f.paths), detailOf(room)));
  }
  dropFile(f.label);
  dropFile(f.paths);
  sweep("codex");
}
process.exit(0);
