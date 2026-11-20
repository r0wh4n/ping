#!/usr/bin/env node
// Codex hook adapter: reports a person's Codex work to their Ping room, label-only.
//
// Wire it in ~/.codex/hooks.json under UserPromptSubmit, PostToolUse and Stop. Codex
// asks you to review and trust each hook once, and that review is deliberate.
import { readFileSync } from "node:fs";
import { describeWork } from "../ping-activity.mjs";
import {
  pickRoom, classifyTask, cleanPrompt, isHumanPrompt, patchPaths, postLine, stateFile, readJson, writeJson, dropFile,
} from "../ping-adapter.mjs";

const CLIENT = "Codex";
const input = JSON.parse(readFileSync(0, "utf8") || "{}");
if (!input.turn_id) process.exit(0);
const file = stateFile("codex", input.turn_id);

if (input.hook_event_name === "UserPromptSubmit") {
  const prompt = cleanPrompt(input.prompt);
  if (!isHumanPrompt(prompt)) process.exit(0); // Codex's own background agents use this event too
  const label = classifyTask(prompt);
  writeJson(file, { label, paths: [] });
  const room = pickRoom(input.cwd);
  if (room) await postLine(room, `${CLIENT} · started: ${label}`);
} else if (input.hook_event_name === "PostToolUse") {
  const st = readJson(file);
  if (st) {
    st.paths.push(...patchPaths(input.tool_input?.command));
    writeJson(file, st);
  }
} else if (input.hook_event_name === "Stop") {
  const st = readJson(file);
  if (st) {
    const where = describeWork(st.paths);
    const room = pickRoom(input.cwd);
    if (room) await postLine(room, `${CLIENT} · finished: ${st.label}${where ? " · " + where : ""}`);
    dropFile(file);
  }
}
process.exit(0);
