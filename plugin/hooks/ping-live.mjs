#!/usr/bin/env node
// Ping live delivery — PostToolUse hook.
//
// The Stop hook only fires when the agent goes idle, so a message sent while
// someone's Claude was mid-task sat unread until it finished — which on a long
// task is the difference between a conversation and a voicemail. This fires
// after every tool call instead, and injects new messages through
// `hookSpecificOutput.additionalContext`: Claude Code wraps that in a system
// reminder next to the tool result, so the agent reads it on its very next
// model request without the tool being blocked or re-run.
//
// It also carries the once-a-minute activity post, so a room sees what each
// member's session is doing while it is doing it, not after.
//
// PostToolUse fires constantly, so the FIRST thing this does is check a clock
// in the state file and exit — one small file read — unless a minute has
// passed. The network is touched at most once a minute per machine.

import { pathToFileURL } from "node:url";
import { readState, updateState, roomsOf, roomMatchesCwd } from "./ping-state.mjs";
import { readStdin, pollRoom, postStatus, collectFresh, saveCursors } from "./ping-watch.mjs";

const TICK_MS = 60_000;
const quiet = () => process.exit(0); // no stdout => nothing injected, tool result untouched

async function main() {
  let input = {};
  try { input = JSON.parse((await readStdin()) || "{}"); } catch {}

  const state = readState();
  if (state.watch !== true) return quiet();

  const at = state.live_at ? Date.parse(state.live_at) : 0;
  if (Date.now() - at < TICK_MS) return quiet();
  // Claim the tick before doing any work: two tool calls can finish within
  // milliseconds of each other, and both would otherwise poll.
  updateState((s) => ({ ...s, live_at: new Date().toISOString() }));

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const rooms = roomsOf(state).filter((r) => roomMatchesCwd(r, cwd));
  if (!rooms.length) return quiet();

  const results = await Promise.all(rooms.map((r) => pollRoom(r)));
  const { blocks, next, changed, anyFresh } = collectFresh(rooms, results, state);
  if (changed) saveCursors(next);
  try { await postStatus(state, rooms, input); } catch { /* best effort */ }
  if (!anyFresh) return quiet();

  // Deliberately not an instruction. The agent is in the middle of something
  // the user asked for; this says what arrived and leaves the judgement of
  // whether to break off to the agent.
  const context =
    `📨 New Ping messages (delivered mid-task — you are not required to stop what you are doing):\n` +
    `${blocks.join("\n")}\n` +
    `Reply with ping_say when you reach a natural break, or now if it is urgent.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
  }));
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
