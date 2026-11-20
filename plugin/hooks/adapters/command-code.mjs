#!/usr/bin/env node
// Command Code hook adapter: reports a person's Command Code work to their Ping room.
//
// Wire it in settings.json under hooks.PostToolUse and hooks.Stop. In interactive mode
// the task is posted at the first tool call, because the transcript exists from the
// start of a turn. In print mode the transcript appears only when the turn ends, so
// the task is posted at Stop instead. How much is shared is chosen with /ping detail.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  pickRoom, classifyTask, isHumanPrompt, transcriptTurn, redact, firstSentence, fileOps, postLine,
  detailOf, startedLine, finishedLine, turnFiles, dropFile, claimOnce, appendLine, readOps, sweep,
} from "../ping-adapter.mjs";

const CLIENT = "Command Code";

// Unreadable input means nothing to report. A crash would surface in the agent's UI
// as a hook error over something the person cannot fix.
let input;
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }
if (!input.session_id) process.exit(0);

// File activity is collected per session, so files touched before the transcript
// shows the request (print mode) still count toward that turn.
const session = turnFiles("command-code", input.session_id);
const t = transcriptTurn(input.transcript_path);
const human = t && isHumanPrompt(t.text) ? t : null;
const turn = human
  ? turnFiles("command-code", input.session_id + "-" + createHash("sha1").update(`${human.index}|${human.text}`).digest("hex").slice(0, 16))
  : null;
const label = human ? classifyTask(human.text) : null;
const task = human ? firstSentence(redact(human.text)) : null;

if (input.hook_event_name === "PostToolUse") {
  for (const o of fileOps(input.tool_name, input.tool_input)) appendLine(session.paths, `${o.op}\t${o.path}`);
  if (turn && claimOnce(turn.started)) {
    const room = pickRoom(input.cwd);
    if (room) await postLine(room, startedLine(CLIENT, label, task, detailOf(room)));
  }
} else if (input.hook_event_name === "Stop") {
  const ops = readOps(session.paths);
  if ((turn || ops.length) && (!turn || claimOnce(turn.finished))) {
    const room = pickRoom(input.cwd);
    if (room) await postLine(room, finishedLine(CLIENT, label ?? "working on a task", ops, detailOf(room)));
  }
  dropFile(session.paths);
  sweep("command-code");
}
process.exit(0);
