// What has this session actually been doing?
//
// Claude Code already writes every tool call to the session transcript, so a
// status update needs no model call and no extra turn — it is a read of a file
// that exists anyway. This turns the tail of that transcript into one line a
// teammate can read without caring how you work:
//
//   ping · shipped a change to the frontend — "Show the join command in the room UI"
//   secure-share · working on the backend
//   youtube · running tests
//
// It used to post the raw material instead — `edited useDM.ts, page.tsx · ran
// npm run build, git push`. Over a day that was 134 lines of somebody else's
// shell history: noise to read, and a far more detailed picture of how a
// person works than anyone agreed to share. The room wants to know who is on
// what, not which commands they typed.
//
// Deliberately narrow about what leaves the machine. Paths are read here to
// classify the work and are NEVER sent — only the label is. Command text is
// read to recognise a test run or a build and is never sent either. Commit
// subjects are sent as written, because they are prose authored to be read by
// other people. Never file contents, never tool output, never what you typed.
// Reads and searches are skipped entirely: looking at a file is not doing
// something.

import { basename } from "node:path";

const EDITORS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const MAX_LEN = 300;

// Which part of the product was touched. Matched against the full path, which
// stays on this machine; only the label travels. First match wins, so a
// .test.tsx counts as tests rather than frontend.
//
// ponytail: a path heuristic, not comprehension — it can say "the frontend"
// when the real answer is "a bug in the invite flow". The commit subject
// carries that meaning when there is one. Swap in an LLM summary here if the
// labels ever prove too coarse to be worth reading.
const AREAS = [
  [/(^|\/)(__tests__|tests?|spec)\//i, "tests"],
  [/\.(test|spec)\.[a-z]+$/i, "tests"],
  [/\.(md|mdx|txt|rst)$/i, "docs"],
  [/(^|\/)(\.github|infra|terraform|deploy|docker)\//i, "infra"],
  [/(Dockerfile|\.ya?ml)$/i, "infra"],
  [/\.sql$/i, "the database"],
  [/(^|\/)(supabase|server|api|backend|db|functions|routes)\//i, "the backend"],
  [/\.(tsx|jsx|css|scss|html|vue|svelte)$/i, "the frontend"],
  [/(^|\/)(components?|pages?|app|ui|styles?|public|src)\//i, "the frontend"],
  [/(^|\/)(scripts?|bin|tools?|hooks?|plugin)\//i, "tooling"],
];
const areaOf = (path) => AREAS.find(([re]) => re.test(path))?.[1] ?? null;

// A session that only ran commands still did something worth a line — but only
// when the command says what. Anything else stays quiet rather than posting
// "ran ls, cd", which is what made the old log unreadable.
const ACTS = [
  [/^(npm (run )?test|yarn test|pnpm test|vitest|jest|pytest|go test|cargo test)/i, "running tests"],
  [/^(npm run build|next build|tsc|cargo build|go build|make)/i, "building"],
  [/^(git push|vercel|supabase|docker|kubectl|fly|wrangler)/i, "deploying"],
];
const actOf = (cmd) => ACTS.find(([re]) => re.test(cmd))?.[1] ?? null;

// `git commit -F -` with a heredoc is as common here as `-m`, so try both and
// fall back to saying nothing rather than guessing wrong.
//
// Scoped to the segment that actually RUNS git commit. Testing the whole
// command string meant any script or heredoc that merely mentioned the words
// donated its own -m "..." to the room: a real session here posted `shipped a
// change — "base"`, a subject nobody ever wrote, lifted out of a Python
// heredoc that happened to contain the phrase. Splitting on && and ; but NOT
// on newlines keeps a heredoc body attached to the command it feeds.
function commitSegment(cmd) {
  return cmd
    .split(/\s*(?:&&|\|\||;)\s*/)
    .find((seg) => /^\s*(?:\w+=\S+\s+)*git\b[^\n]*\bcommit\b/.test(seg));
}

function commitSubject(cmd) {
  const seg = commitSegment(cmd);
  if (!seg) return null;
  const head = seg.split("\n")[0];

  const inline = head.match(/-m\s+["']([^"']{3,120})/);
  if (inline) return inline[1];

  // `git commit -F -` fed by a heredoc. The body cannot be read out of the
  // segment: `<<'MSG' && git log` puts the redirect and its body on opposite
  // sides of the split, which is how this repo writes every commit. So find
  // the delimiter in the segment and the body in the whole command — it is
  // simply the line after the redirect.
  const delim = head.match(/<<\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/)?.[1];
  if (!delim) return null;
  const lines = cmd.split("\n");
  const open = lines.findIndex((l) => new RegExp(`<<\\s*['"]?${delim}['"]?`).test(l));
  // A real heredoc closes on a line of its own. Without that this is a string
  // that merely contains the words — a fixture, a script being written — and
  // its next line is not a commit subject.
  if (open < 0 || !lines.slice(open + 1).some((l) => l.trim() === delim)) return null;
  const subject = (lines[open + 1] ?? "").trim();
  return subject.length >= 3 && subject.length <= 120 ? subject : null;
}

// The recognisable head of a command: `npm run build`, `git push`, `node x.mjs`.
const commandHead = (cmd) => {
  const first = cmd.trim().split(/\s*(?:&&|\|\||\||;|\n)/)[0].trim();
  const words = first.split(/\s+/).filter((w) => !w.includes("="));
  return words.slice(0, words[0] === "npm" || words[0] === "git" || words[0] === "npx" ? 3 : 1).join(" ");
};

/** "the frontend" · "the frontend and tests" · null when nothing classified. */
const phrase = (areas) => (areas.length ? areas.slice(0, 2).join(" and ") : null);

/**
 * One line for a commit. Shared by the Claude Code hook, which reads the
 * session transcript, and the MCP proxy, which reads git — so a Cursor or
 * Codex agent's commit reads exactly like a Claude Code one in the room.
 */
export function describeCommit(subject, files = []) {
  const where = phrase([...new Set(files.map(areaOf).filter(Boolean))]);
  return `shipped a change${where ? ` to ${where}` : ""} — "${subject}"`;
}

/** One line for work in progress, from whatever files are currently dirty. */
export function describeWork(files = []) {
  if (!files.length) return null;
  const where = phrase([...new Set(files.map(areaOf).filter(Boolean))]);
  return `working on ${where ?? "it"}`;
}

/** `git status --porcelain` into the paths it names. */
export function parseStatus(stdout) {
  return String(stdout || "")
    .split("\n")
    .map((l) => l.slice(3).trim())          // "XY path", and " -> " for renames
    .map((l) => (l.includes(" -> ") ? l.split(" -> ")[1] : l))
    .filter(Boolean);
}

/**
 * `git log --format=%x01%cI%x00%ae%x00%s --name-only` into
 * {at, email, subject, files}. One exec, newest first, parsed here so it can
 * be tested without a repo.
 *
 * The author's address is carried because a pull brings in everyone else's
 * commits: without it, the first teammate to run `git pull` told the room they
 * had shipped work somebody else wrote, minutes after that person shipped it.
 */
export function parseCommitLog(stdout) {
  return String(stdout || "")
    .split("\x01")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [head, ...rest] = chunk.split("\n");
      const [at, email, subject] = head.split("\x00");
      return {
        at,
        email: (email ?? "").trim().toLowerCase(),
        subject: (subject ?? "").trim(),
        files: rest.map((l) => l.trim()).filter(Boolean),
      };
    })
    .filter((c) => c.at && c.subject);
}

// What the person actually asked for, in their own words.
//
// Everything else here reads effects — files, commits — and effects cannot say
// what the work was FOR. "working on the frontend" was true of building a game
// and of deleting one; a room full of it told nobody anything. The task is the
// one thing that answers "what are they doing", and it is sitting in the
// transcript as the prompt.
//
// This is the only place anything a person typed leaves the machine. It is the
// request line, trimmed to one sentence — never the conversation, never a
// reply, never a file or its contents.
const TASK_MAX = 110;

export function taskFrom(entry) {
  const c = entry?.message?.content;
  // A tool result is also a "user" entry. It is machine output, not a request.
  if (Array.isArray(c) && c.some((p) => p?.type === "tool_result")) return null;
  const raw = typeof c === "string"
    ? c
    : Array.isArray(c) ? c.filter((p) => p?.type === "text").map((p) => p.text).join(" ") : "";
  const text = String(raw)
    .replace(/<[^>]*>[\s\S]*?<\/[^>]*>/g, " ")  // pasted blocks, reminders, command wrappers
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.startsWith("/")) return null;   // a slash command is not a task
  const first = text.split(/(?<=[.!?])\s/)[0].trim();
  if (first.length <= TASK_MAX) return first;
  // Cut on a word boundary. Slicing at the character left "…which it give…",
  // which reads like a transcription error rather than a trimmed sentence.
  const cut = first.slice(0, TASK_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > TASK_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/**
 * @param lines raw transcript lines (JSONL, newest last)
 * @param since ISO timestamp already reported; only later entries count
 * @returns {{text: string, until: string} | null} null when nothing happened
 */
export function summarize(lines, since) {
  const paths = new Set();
  const acts = new Set();
  const commits = [];
  let until = since || "";
  let project = "";
  let task = null;

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
    if (!o?.timestamp) continue;
    if (since && o.timestamp <= since) continue;
    if (o.type === "user") {
      const asked = taskFrom(o);
      if (asked) { task = asked; if (o.timestamp > until) until = o.timestamp; }
      continue;
    }
    if (o.type !== "assistant") continue;
    if (o.timestamp > until) until = o.timestamp;
    if (o.cwd) project = basename(o.cwd);

    const parts = Array.isArray(o?.message?.content) ? o.message.content : [];
    for (const p of parts) {
      if (p?.type !== "tool_use") continue;
      if (EDITORS.has(p.name) && typeof p.input?.file_path === "string") {
        paths.add(p.input.file_path);
      } else if (p.name === "Bash" && typeof p.input?.command === "string") {
        const cmd = p.input.command;
        const subject = commitSubject(cmd);
        if (subject) commits.push(subject);
        const act = actOf(commandHead(cmd));
        if (act) acts.add(act);
      }
    }
  }

  const where = phrase([...new Set([...paths].map(areaOf).filter(Boolean))]);

  let body;
  if (commits.length) {
    body = describeCommit(commits[commits.length - 1], [...paths]);
  } else if (paths.size) {
    body = `working on ${where ?? "it"}`;
  } else if (acts.size) {
    body = [...acts].join(" and ");
  } else if (!task) {
    return null;
  }

  // The task leads, because it is the answer to "what are they doing". The
  // effects follow as evidence. A task on its own still reports: research,
  // reading and answering leave nothing behind, and silence read as idle.
  const text = [project, task && `“${task}”`, body].filter(Boolean).join(" · ");
  return { text: text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + "…" : text, until };
}
