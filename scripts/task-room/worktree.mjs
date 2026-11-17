import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { clean } from "./agents.mjs";

// Isolation for a parallel run.
//
// Three CLIs editing one directory at the same time is not a race anyone wins:
// the last writer silently erases the other two, and the handoffs still claim
// all three succeeded. So each agent gets its own worktree on its own branch.
//
// The coordinator commits whatever the agent leaves behind. Without that the
// work dies with the worktree, and "you merge the branches" means nothing --
// an uncommitted change is not on a branch. Agents are told not to commit, and
// mostly don't; this is the backstop that makes the result durable either way.
const git = promisify(execFile);
const run = async (args, cwd) => {
  try { return (await git("git", args, { cwd, timeout: 60_000, maxBuffer: 1 << 20 })).stdout; }
  catch (error) { throw new Error(clean(`git ${args[0]}: ${error.stderr || error.message}`).trim().slice(0, 500)); }
};

export async function isRepo(cwd) {
  try { return (await run(["rev-parse", "--is-inside-work-tree"], cwd)).trim() === "true"; }
  catch { return false; }
}

// Branches are named per run, so two coordinators in one repo never collide and
// an abandoned run leaves something you can find rather than `ping/claude`.
export const branchFor = (runId, id) => `ping/${runId}/${id}`;

export async function addWorktree({ cwd, dir, branch }) {
  await run(["worktree", "add", "-b", branch, dir, "HEAD"], cwd);
  return dir;
}

/** Commit the agent's changes on its own branch. Returns the sha, or null if it changed nothing. */
export async function commitWork({ dir, message }) {
  await run(["add", "-A"], dir);
  if (!(await run(["status", "--porcelain"], dir)).trim()) return null;
  // --no-verify: this is the coordinator's bookkeeping commit on a scratch
  // branch, and a repo's pre-commit hook failing here would throw away the
  // agent's work to enforce a rule the user will see at merge time anyway.
  await run(["commit", "--no-verify", "-m", message.slice(0, 2000)], dir);
  return (await run(["rev-parse", "--short", "HEAD"], dir)).trim();
}

// The branch is what you merge; the directory is just where it was typed. Taking
// it away keeps ~/.ping from filling with checkouts of every repo you've run on.
export async function removeWorktree({ cwd, dir }) {
  await run(["worktree", "remove", "--force", dir], cwd);
}
