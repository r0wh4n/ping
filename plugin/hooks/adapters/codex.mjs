#!/usr/bin/env node
// Codex hook adapter: reports a person's Codex work to their Ping room, label-only.
//
// Wire it in ~/.codex/hooks.json under UserPromptSubmit, PostToolUse and Stop. Codex
// asks you to review and trust each hook once, and that review is deliberate.
import { readFileSync } from "node:fs";
import { describeWork } from "../ping-activity.mjs";
import {
  pickRoom, classifyTask, cleanPrompt, isHumanPrompt, patchPaths, postLine,
  turnFiles, readJson, writeJson, dropFile, claimOnce, appendLine, readLines, sweep,
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
  writeJson(f.label, { label });
  if (claimOnce(f.started)) {
    const room = pickRoom(input.cwd);
    if (room) await postLine(room, `${CLIENT} · started: ${label}`);
  }
} else if (input.hook_event_name === "PostToolUse") {
  if (readJson(f.label)) for (const p of patchPaths(input.tool_input?.command)) appendLine(f.paths, p);
} else if (input.hook_event_name === "Stop") {
  const st = readJson(f.label);
  if (st && claimOnce(f.finished)) {
    const where = describeWork(readLines(f.paths));
    const room = pickRoom(input.cwd);
    if (room) await postLine(room, `${CLIENT} · finished: ${st.label}${where ? " · " + where : ""}`);
  }
  dropFile(f.label);
  dropFile(f.paths);
  sweep("codex");
}
process.exit(0);
