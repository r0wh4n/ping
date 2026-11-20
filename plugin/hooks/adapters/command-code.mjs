#!/usr/bin/env node
// Command Code hook adapter: reports a person's Command Code work to their Ping room, label-only.
//
// Wire it in settings.json under hooks.PostToolUse and hooks.Stop. In interactive mode
// the task is posted at the first tool call, because the transcript exists from the
// start of a turn. In print mode the transcript appears only when the turn ends, so
// the task is posted at Stop instead.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describeWork } from "../ping-activity.mjs";
import {
  pickRoom, classifyTask, isHumanPrompt, transcriptPrompt, postLine, stateFile, readJson, writeJson, dropFile,
} from "../ping-adapter.mjs";

const CLIENT = "Command Code";
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
if (!input.session_id) process.exit(0);
const file = stateFile("command-code", input.session_id);

// Only a human request starts a turn. A turn is identified by its request, so a new
// request in the same session starts a new turn.
const prompt = transcriptPrompt(input.transcript_path);
const human = isHumanPrompt(prompt) ? prompt : null;
const turn = human ? createHash("sha1").update(human).digest("hex").slice(0, 16) : null;

// Edits can arrive before the transcript shows the request (print mode). They stay
// pending and are adopted once the request appears.
let st = readJson(file) || { turn: null, label: null, paths: [], started: false };
if (turn && st.turn !== turn) {
  st = st.turn === null
    ? { ...st, turn, label: classifyTask(human) }
    : { turn, label: classifyTask(human), paths: [], started: false };
}

if (input.hook_event_name === "PostToolUse") {
  const fp = input.tool_input?.file_path;
  if (EDIT_TOOLS.has(input.tool_name) && typeof fp === "string") st.paths.push(fp);
  if (st.turn && !st.started) {
    st.started = true;
    const room = pickRoom(input.cwd);
    if (room) await postLine(room, `${CLIENT} · started: ${st.label}`);
  }
  writeJson(file, st);
} else if (input.hook_event_name === "Stop") {
  if (st.turn || st.paths.length) {
    const where = describeWork(st.paths);
    const room = pickRoom(input.cwd);
    if (room) await postLine(room, `${CLIENT} · finished: ${st.label ?? "working on a task"}${where ? " · " + where : ""}`);
  }
  dropFile(file);
}
process.exit(0);
