import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export const AGENTS = {
  claude: { role: "Plan the approach, identify constraints, and resolve open design questions. On later rounds check the implementation against the task." },
  codex: { role: "Implement the agreed changes in the workspace. Address concrete feedback from the other agents." },
  commandcode: { role: "Review the current changes for correctness and maintainability. Give concrete findings with file references and suggested fixes." },
  opencode: { role: "Verify the changes with the project's checks where permitted. Report commands actually run, results, and remaining gaps." },
};

export function clean(text) {
  return stripVTControlCharacters(String(text))
    .replace(/\b(?:gm_|gk_)[A-Za-z0-9_-]+/g, "[redacted Ping credential]");
}

export function invocationFor(agent, prompt) {
  if (!Object.hasOwn(AGENTS, agent.id)) throw new Error(`Unknown agent: ${agent.id}`);
  let args;
  let stdin = prompt;
  switch (agent.id) {
    case "codex": args = ["exec", "--json", "--sandbox", "workspace-write"]; break;
    case "claude": args = ["--print", "--output-format", "json", "--permission-mode", "acceptEdits"]; break;
    case "commandcode": args = ["--print", "--output-format", "json", "--max-turns", "20", "--skip-onboarding", "--no-auto-update"]; break;
    case "opencode": args = ["run", "--format", "json"]; break;
  }
  if (agent.model) args.push("--model", agent.model);
  // OpenCode accepts its prompt as a positional argument; the others accept
  // stdin. Never pass any prompt through a shell or a command template.
  if (agent.id === "opencode") { args.push("--", prompt); stdin = ""; }
  if (agent.id === "codex") args.push("-");
  return { command: agent.command || agent.id, args: [...(agent.args || []), ...args], stdin };
}

export function parseReply(id, output) {
  let frames;
  try { frames = [JSON.parse(output)]; }
  catch {
    frames = output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
  let reply = "";
  for (const frame of frames) {
    if (!frame || typeof frame !== "object") continue;
    if (frame.is_error || frame.type === "error" || frame.type === "turn.failed" ||
        (frame.type === "result" && frame.subtype && frame.subtype !== "success")) {
      throw new Error(clean(`${id}: ${frame.error?.message || frame.error || frame.result || frame.subtype || "agent error"}`).slice(0, 2000));
    }
    if (id === "codex" && frame.type === "item.completed" && frame.item?.type === "agent_message") reply = frame.item.text;
    if (id === "claude" && frame.type === "result") reply = frame.result;
    if (id === "commandcode" && frame.type === "result") reply = frame.finalText;
    if (id === "opencode" && frame.type === "text" && typeof frame.part?.text === "string") reply += frame.part.text;
  }
  if (typeof reply !== "string" || !reply.trim()) throw new Error(`${id} returned no final response in its JSON output.`);
  return clean(reply.trim());
}

// One process group per turn means Ctrl-C/timeout also reaches tools launched
// by the CLI on macOS/Linux. Inherited external services are outside this group.
export function runAgent(agent, prompt, { cwd, timeoutMs, signal }) {
  signal?.throwIfAborted();
  const call = invocationFor(agent, prompt);
  return new Promise((resolve, reject) => {
    const child = spawn(call.command, call.args, {
      cwd, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", bytes = 0, failure, killTimer;
    const kill = (name) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch { /* process already exited */ }
    };
    const stop = (error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = () => stop(new Error("Task cancelled."));
    const timer = setTimeout(() => stop(new Error(`${agent.id} timed out after ${timeoutMs}ms.`)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (chunk, isError) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024) { stop(new Error(`${agent.id} exceeded the 2 MiB output limit.`)); return; }
      if (isError) stderr = (stderr + chunk).slice(-8000);
      else stdout += chunk;
    };
    child.stdout.on("data", (chunk) => collect(chunk, false));
    child.stderr.on("data", (chunk) => collect(chunk, true));
    child.on("error", (error) => { failure = new Error(clean(error.message)); });
    // A CLI may exit before consuming stdin (bad auth, unknown flag, etc.).
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") stop(error); });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      // A tool may have ignored SIGTERM after its parent exited.
      if (failure) { kill("SIGKILL"); reject(failure); return; }
      if (code !== 0) {
        reject(new Error(`${agent.id} exited ${code ?? exitSignal}: ${clean(stderr).trim().slice(-2000) || "no diagnostic output"}`));
        return;
      }
      try { resolve(parseReply(agent.id, stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(call.stdin);
  });
}
