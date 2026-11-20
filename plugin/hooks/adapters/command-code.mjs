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
  pickRoom, classifyTask, isHumanPrompt, transcriptTurn, postLine,
  turnFiles, dropFile, claimOnce, appendLine, readLines, sweep,
} from "../ping-adapter.mjs";

const CLIENT = "Command Code";
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);

// Unreadable input means nothing to report. A crash would surface in the agent's UI
// as a hook error over something the person cannot fix.
let input;
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }
if (!input.session_id) process.exit(0);

// Edits are collected per session, so ones made before the transcript shows the
// request (print mode) still count toward that turn.
const session = turnFiles("command-code", input.session_id);
const t = transcriptTurn(input.transcript_path);
const human = t && isHumanPrompt(t.text) ? t : null;
const turn = human
  ? turnFiles("command-code", input.session_id + "-" + createHash("sha1").update(`${human.index}|${human.text}`).digest("hex").slice(0, 16))
  : null;
const label = human ? classifyTask(human.text) : null;

if (input.hook_event_name === "PostToolUse") {
  const fp = input.tool_input?.file_path;
  if (EDIT_TOOLS.has(input.tool_name) && typeof fp === "string") appendLine(session.paths, fp);
  if (turn && claimOnce(turn.started)) {
    const room = pickRoom(input.cwd);
    if (room) await postLine(room, `${CLIENT} · started: ${label}`);
  }
} else if (input.hook_event_name === "Stop") {
  const paths = readLines(session.paths);
  if ((turn || paths.length) && (!turn || claimOnce(turn.finished))) {
    const where = describeWork(paths);
    const room = pickRoom(input.cwd);
    if (room) await postLine(room, `${CLIENT} · finished: ${label ?? "working on a task"}${where ? " · " + where : ""}`);
  }
  dropFile(session.paths);
  sweep("command-code");
}
process.exit(0);
