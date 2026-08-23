#!/usr/bin/env node
// Ping auto-delivery — Stop hook.
//
// Fires when the agent goes idle. Checks the watched Ping room for messages from
// OTHERS since we last looked; if any, it blocks the stop and injects them so the
// agent picks them up on its own — no "check inbox". Nothing new -> let it stop.
//
// Cursor is the message's own created_at (DB ISO string). We never compare against
// a locally-generated date, so there's no format-mismatch skew. ponytail: single
// watched room (last one /ping connected); multi-room watch later.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const DIR = join(homedir(), ".ping");
const STATE = join(DIR, "state.json");
const API = "https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1/group-api";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzZHNsa3hkb3F3c3BqZm96d3ZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5ODg3NjQsImV4cCI6MjEwMDU2NDc2NH0.Kuop6VvV3Ykak8SqH8yBJbt0H6N-mB2-riSVFQS7aDo";
const FLOOR = "0000-01-01T00:00:00+00:00"; // sorts before any real timestamp

const allowStop = () => process.exit(0); // no stdout + exit 0 => agent stops normally
const writeState = (s) => {
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(s)); } catch {}
};

function readStdin() {
  return new Promise((res) => {
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => res(d));
    setTimeout(() => res(d), 500); // fallback if no stdin (e.g. manual run)
  });
}

async function main() {
  let input = {};
  try { input = JSON.parse((await readStdin()) || "{}"); } catch {}
  if (input.stop_hook_active) return allowStop(); // loop cap reached -> stop

  let state;
  try { state = JSON.parse(readFileSync(STATE, "utf8")); } catch { return allowStop(); }
  if (!state?.token || state.watch !== true) return allowStop(); // not connected / paused

  // Shell out to curl (portable across TLS/proxy setups; same call the /ping command uses).
  let msgs = [];
  try {
    const { stdout } = await execFileP(
      "curl",
      [
        "-s", "-X", "POST", API,
        "-H", `apikey: ${ANON}`,
        "-H", `Authorization: Bearer ${state.token}`,
        "-H", "Content-Type: application/json",
        // Pass OUR own cursor so the server doesn't advance the shared last_read
        // that the agent's interactive ping_read / ping_wait rely on.
        "-d", JSON.stringify({ action: "read", since: state.last_seen || FLOOR }),
      ],
      { timeout: 10000 }
    );
    const data = JSON.parse(stdout);
    msgs = Array.isArray(data?.messages) ? data.messages : [];
  } catch { return allowStop(); } // network/parse hiccup -> never disrupt the session

  // First run: set cursor to newest existing message (treat history as already seen)
  if (!state.last_seen) {
    const newest = msgs.reduce((a, m) => ((m.created_at || "") > a ? m.created_at : a), FLOOR);
    writeState({ ...state, last_seen: newest });
    return allowStop();
  }

  const fresh = msgs.filter((m) => m && m.mine === false && (m.created_at || "") > state.last_seen);
  if (fresh.length === 0) return allowStop();

  const newest = fresh.reduce((a, m) => (m.created_at > a ? m.created_at : a), state.last_seen);
  writeState({ ...state, last_seen: newest }); // advance cursor so we never re-deliver

  const lines = fresh.map((m) => `  [${m.from}] ${m.text}`).join("\n");
  const reason =
    `📨 New message${fresh.length > 1 ? "s" : ""} in your Ping room "${state.group || "group"}":\n` +
    `${lines}\n\n` +
    `If a reply makes sense, use the ping_say tool (ping MCP) to answer in the room. ` +
    `If nothing is needed, you can stop.`;

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

main();
