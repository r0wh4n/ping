#!/usr/bin/env node
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AGENTS, clean, invocationFor } from "./task-room/agents.mjs";
import { PingRoom } from "./task-room/ping.mjs";
import { runRoom } from "./task-room/room.mjs";

const HELP = `Ping task room — run your coding agents on one task (Node 22+, macOS/Linux).

  node scripts/ping-task.mjs --task "Fix the login bug" --cwd /path/to/repo

  --agents LIST     Turn order (default: claude,codex,commandcode,opencode)
  --rounds N        Rounds through all agents, 1–10 (default: 2)
  --timeout N       Seconds per agent turn, 1–3600 (default: 300)
  --config FILE     JSON with per-agent command, args, model and role overrides
  --out DIR         New transcript directory (default: ~/.ping/tasks/<run-id>)
  --room LINK       Also read/publish to this Ping room invite link or gk_ code
  --endpoint URL    MCP endpoint (default: https://theping.chat/mcp)
  --dry-run        Show the plan without launching agents or joining a room
  --help           Show this help

Uses each CLI's existing login and permissions. No permission bypass is added.
Runs one agent at a time in the same workspace; Ctrl-C cancels the current turn.
"finished" means all turns ran, not that the agents proved the task correct.
`;

export function parseOptions(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const options = { cwd: process.cwd(), agents: Object.keys(AGENTS), rounds: 2, timeout: 300 };
  const values = new Set(["task", "cwd", "agents", "rounds", "timeout", "config", "out", "room", "endpoint"]);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].startsWith("--") ? argv[i].slice(2) : "";
    if (key === "dry-run") { options.dryRun = true; continue; }
    if (!values.has(key)) throw new Error(`Unknown option: ${argv[i]}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    options[key] = value;
  }
  if (typeof options.task !== "string" || !options.task.trim() || options.task.length > 12000) throw new Error("--task needs 1–12000 characters.");
  if (typeof options.agents === "string") options.agents = options.agents.split(",").map((a) => a.trim());
  if (!options.agents.length || new Set(options.agents).size !== options.agents.length || options.agents.some((id) => !Object.hasOwn(AGENTS, id))) throw new Error(`--agents must list distinct names from ${Object.keys(AGENTS).join(", ")}.`);
  for (const [key, max] of [["rounds", 10], ["timeout", 3600]]) {
    options[key] = Number(options[key]);
    if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > max) throw new Error(`--${key} must be an integer from 1 to ${max}.`);
  }
  if (options.endpoint && !options.room) throw new Error("--endpoint requires --room.");
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) { process.stdout.write(HELP); return 0; }
  const cwd = await realpath(options.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error("--cwd must be a directory.");
  const config = options.config ? JSON.parse(await readFile(resolve(options.config), "utf8")) : {};
  if (!config || typeof config !== "object" || Array.isArray(config) || (config.agents !== undefined && (!config.agents || typeof config.agents !== "object" || Array.isArray(config.agents)))) throw new Error("Config must be an object with an optional agents object.");
  for (const [id, agent] of Object.entries(config.agents || {})) {
    if (!Object.hasOwn(AGENTS, id) || !agent || typeof agent !== "object" || Array.isArray(agent) ||
        Object.keys(agent).some((key) => !["command", "args", "role", "model"].includes(key)) ||
        ["command", "role", "model"].some((key) => agent[key] !== undefined && (typeof agent[key] !== "string" || !agent[key].trim() || agent[key].length > 4000)) ||
        (agent.args !== undefined && (!Array.isArray(agent.args) || agent.args.some((a) => typeof a !== "string")))) throw new Error(`Invalid config for agent ${id}.`);
  }
  const agents = options.agents.map((id) => ({ id, ...config.agents?.[id] }));
  const bridge = options.room ? new PingRoom({ link: options.room, endpoint: options.endpoint }) : undefined;
  if (options.dryRun) {
    console.log(JSON.stringify({ cwd, task: options.task, rounds: options.rounds, timeout: options.timeout, sharedRoom: Boolean(bridge), agents: agents.map((a) => ({ id: a.id, role: a.role || AGENTS[a.id].role, ...invocationFor(a, "[shared task and transcript]") })) }, null, 2));
    return 0;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const outputDir = options.out ? resolve(options.out) : join(homedir(), ".ping", "tasks", randomUUID());
  console.log(`Task room: ${outputDir}\nWorkspace: ${cwd}\nOrder: ${agents.map((a) => a.id).join(" → ")}`);
  try {
    const result = await runRoom({
      task: options.task, cwd, agents, rounds: options.rounds, timeoutMs: options.timeout * 1000,
      outputDir, signal: controller.signal, bridge,
      onEvent(event) {
        if (event.type === "turn") console.log(`\n[${event.agent} · round ${event.round}/${options.rounds}] working…`);
        if (["reply", "failure", "warning"].includes(event.type)) console.log(clean(event.text));
      },
    });
    console.log(`\n${result.status}: ${result.replies} replies, ${result.failures} failed turns, ${result.integrationFailures} room errors.\nTranscript: ${result.transcript}`);
    return result.status === "cancelled" ? 130 : result.status === "finished" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Ping: ${clean(error.message)}`);
    process.exitCode = 1;
  });
}
