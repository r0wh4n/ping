// What has this session actually been doing?
//
// Claude Code already writes every tool call to the session transcript, so a
// status update needs no model call and no extra turn — it is a read of a file
// that exists anyway. This turns the tail of that transcript into one line:
//
//   ping · edited ConnectAI.tsx, page.tsx · ran npm run build, git push
//         · committed "Show the join command in the room UI"
//
// Deliberately narrow about what leaves the machine. File BASENAMES, not paths
// — a path leaks your directory layout and often a client's name. The head of a
// command, not its arguments. Commit subjects, which are written to be read.
// Never file contents, never tool output, never what you typed. Reads and
// searches are skipped entirely: looking at a file is not doing something.

import { basename } from "node:path";

const EDITORS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const MAX_LEN = 300;

// `git commit -F -` with a heredoc is as common here as `-m`, so try both and
// fall back to saying nothing rather than guessing wrong.
function commitSubject(cmd) {
  const m = cmd.match(/-m\s+["']([^"']{3,120})/);
  if (m) return m[1];
  const heredoc = cmd.match(/<<\s*'?EOF'?\s*\n([^\n]{3,120})/);
  return heredoc ? heredoc[1] : null;
}

// The recognisable head of a command: `npm run build`, `git push`, `node x.mjs`.
const commandHead = (cmd) => {
  const first = cmd.trim().split(/\s*(?:&&|\|\||\||;|\n)/)[0].trim();
  const words = first.split(/\s+/).filter((w) => !w.includes("="));
  return words.slice(0, words[0] === "npm" || words[0] === "git" || words[0] === "npx" ? 3 : 1).join(" ");
};

const list = (items, cap) =>
  items.length <= cap ? items.join(", ") : `${items.slice(0, cap).join(", ")} +${items.length - cap} more`;

/**
 * @param lines raw transcript lines (JSONL, newest last)
 * @param since ISO timestamp already reported; only later entries count
 * @returns {{text: string, until: string} | null} null when nothing happened
 */
export function summarize(lines, since) {
  const files = new Set();
  const commands = new Set();
  const commits = [];
  let until = since || "";
  let project = "";

  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a partially-written last line is normal while a session runs
    }
    // Only `assistant` entries: the same content is mirrored into
    // api-request-blob entries that carry no timestamp, and counting both
    // doubles everything.
    if (o?.type !== "assistant" || !o.timestamp) continue;
    if (since && o.timestamp <= since) continue;
    if (o.timestamp > until) until = o.timestamp;
    if (o.cwd) project = basename(o.cwd);

    const parts = Array.isArray(o?.message?.content) ? o.message.content : [];
    for (const p of parts) {
      if (p?.type !== "tool_use") continue;
      if (EDITORS.has(p.name) && typeof p.input?.file_path === "string") {
        files.add(basename(p.input.file_path));
      } else if (p.name === "Bash" && typeof p.input?.command === "string") {
        const cmd = p.input.command;
        const subject = /git\s+commit/.test(cmd) ? commitSubject(cmd) : null;
        if (subject) commits.push(subject);
        const head = commandHead(cmd);
        if (head) commands.add(head);
      }
    }
  }

  const bits = [];
  if (files.size) bits.push(`edited ${list([...files], 4)}`);
  if (commands.size) bits.push(`ran ${list([...commands], 3)}`);
  if (commits.length) bits.push(`committed ${commits.slice(-2).map((c) => `"${c}"`).join(", ")}`);
  if (!bits.length) return null;

  const text = [project, bits.join(" · ")].filter(Boolean).join(" · ");
  return { text: text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + "…" : text, until };
}
