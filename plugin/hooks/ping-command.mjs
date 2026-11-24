#!/usr/bin/env node
// Install /ping as a personal skill — SessionStart hook.
//
// Claude Code names every plugin command <plugin>:<command>, so the plugin's
// own copy could only ever be /ping:ping. Plain /ping was not a command at all:
// it reached the model as text and worked only when the model guessed what was
// meant. A personal skill in ~/.claude/skills has no prefix, so this writes one
// at the start of every session, pointing at THIS version's scripts — which
// also keeps it current across plugin updates.
//
// A skill, not a command: commands are read once when a session starts, before
// this hook has run, so a fresh install would have needed a second restart.
// Skills are reloaded while a session runs (measured: listed ~10s in).
//
// Never touches a ping skill the person wrote: only a file carrying MARK is
// replaced. Prints nothing, because SessionStart output is added to the
// session's context.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MARK = "<!-- Written by the Ping plugin at each session start. Delete this line to keep your own edits. -->";

export function render(template, root) {
  // name: makes it /ping, whatever the folder is called.
  const body = template.split("${CLAUDE_PLUGIN_ROOT}").join(root).replace(/^---\n/, "---\nname: ping\n");
  // After the frontmatter, so Claude Code still reads it as frontmatter.
  const end = body.startsWith("---") ? body.indexOf("\n---", 3) : -1;
  if (end < 0) return `${MARK}\n${body}`;
  const cut = body.indexOf("\n", end + 4);
  return `${body.slice(0, cut + 1)}\n${MARK}\n${body.slice(cut + 1)}`;
}

export function install(root, configDir) {
  const target = join(configDir, "skills", "ping", "SKILL.md");
  const next = render(readFileSync(join(root, "templates", "ping.md"), "utf8"), root);
  let now = null;
  try { now = readFileSync(target, "utf8"); } catch { /* not there yet */ }
  if (now !== null && !now.includes(MARK)) return "kept"; // theirs
  if (now === next) return "current";
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, target);
  return now === null ? "installed" : "updated";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = process.env.CLAUDE_PLUGIN_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
    install(root, process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
  } catch { /* never break a session start over this */ }
  process.exit(0);
}
