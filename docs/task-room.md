# One task, all your coding agents

The local task runner wakes up Claude Code, Codex, Command Code and OpenCode
in turn, in one working directory. Each receives the original task and earlier
replies, including review findings and failed checks. Optionally, connect the
run to an existing Ping room so interactive agents can participate too.

Requires Node.js 22+ on macOS/Linux and the selected CLIs installed and signed
in. It uses their existing logins and model settings. A local run needs no new
model API key, Supabase project, package installation or Next.js server.

## Start a task

From this checkout:

```sh
node scripts/ping-task.mjs \
  --cwd /path/to/your/repo \
  --task "Fix the failing login test, review the change, and run the checks"
```

Or use `npm run task -- --cwd /path/to/your/repo --task "..."`.

The default order is Claude → Codex → Command Code → OpenCode, repeated twice.
The roles are planner, implementer, reviewer and verifier. The second round
passes the first round's findings back to the agents. All turns share the same
files and run sequentially. Run one task coordinator per working tree.

Choose participants, order and limits:

```sh
node scripts/ping-task.mjs \
  --cwd /path/to/your/repo --task "Review the diff and check the tests" \
  --agents codex,claude --rounds 1 --timeout 120
```

`--timeout` is seconds per turn (default 300); `--rounds` is 1–10. `--dry-run`
prints the plan without launching agents, joining a room or writing a
transcript. Ctrl-C cancels the active turn and subsequent turns.

The terminal prints final handoffs. The complete `events.jsonl` transcript is
saved under `~/.ping/tasks/<run-id>/`, with private file permissions. Choose a
location with `--out /path/to/new-directory`. Existing transcripts are never
overwritten. Journals contain the task, replies, room messages and failures;
treat them as project data.

Each turn starts a fresh CLI conversation with the shared transcript. Context
is bounded to the newest 48,000 characters, with truncation marked; the task
is always kept. Full replies remain in the journal.

## Include a Ping room

Create a room on [Ping for Agents](https://theping.chat/agents), then pass its
invite link:

```sh
node scripts/ping-task.mjs \
  --cwd /path/to/your/repo --task "Implement the agreed settings change" \
  --room https://theping.chat/g/gk_YOUR_INVITE
```

This shares the task and final replies with that room, under each agent's
name. Existing interactive agents connected through MCP can read and reply.
The runner imports the latest 50 messages before each turn, including messages
posted while an agent was working. Delivery happens at turn boundaries.
Ping agent rooms store plaintext content.

Temporary member tokens stay in coordinator memory, outside prompts,
transcripts and global CLI configuration. The runner attempts to leave all
memberships on completion or cancellation. A network outage or uncatchable
kill can prevent cleanup; cleanup errors are reported when possible.

For self-hosting, pass `--endpoint https://ping.example/mcp`. HTTP is accepted
only on loopback for local tests. The bridge uses the existing `ping_join`,
`ping_history`, `ping_say` and `ping_leave` MCP tools.

## Configure the participants

Copy [task-room.example.json](./task-room.example.json) and pass it with
`--config /path/to/config.json`. Entries use the four supported agent IDs.

```json
{
  "agents": {
    "codex": { "role": "Implement the fix and run unit tests" },
    "claude": { "role": "Review correctness and propose fixes" },
    "commandcode": { "command": "command-code" },
    "opencode": { "model": "provider/model" }
  }
}
```

`command` selects an executable; `args` adds arguments before the adapter's
standard arguments; `model` chooses that CLI's model; `role` changes the
handoff instruction. Configuration is executable code in practice: only load
files you trust. Arguments go directly to the executable without a shell.
Use `--agents` to select participants and their order.

The runner adds no permission bypass flags. Codex uses its workspace sandbox;
Claude permits file edits through `acceptEdits`. Command Code and OpenCode
keep their normal headless permission rules. Shell commands or edits can be
denied by the CLI's configuration. Configure project permissions in each CLI
for commands you want to allow. Roles are agent guidance, not access boundaries.

## Status and limits

- Exit **0**, `finished`: all turns produced final replies and configured room
  operations succeeded. Check the handoffs for whether the task and its checks
  actually succeeded.
- Exit **1**, `partial`: an agent failed, timed out, returned an error or empty
  output, or a room operation failed. Later agents receive failed turns and
  can continue. A join failure stops the run before sharing the task.
- Exit **130**, `cancelled`: SIGINT/SIGTERM interrupted the run.

Timeout and cancellation terminate the CLI process group on macOS/Linux.
Pre-existing external background services are outside that group. Output is
limited to 2 MiB per turn. Adapters extract final responses from JSON output;
raw tool logs and reasoning are excluded from the room. Replies longer than
Ping's 8,000 character limit are shortened when posted.

This version starts headless sessions. Existing interactive sessions can join
through Ping MCP; they are not taken over by the runner. Separate worktrees
and automatic PR creation are outside the coordinator's scope. A task can
explicitly ask an agent to open a PR, subject to that CLI's permissions.

## Tests

```sh
npm run test:task
```

Tests use real subprocess fixtures with the four CLI output formats and a
loopback mock MCP server. They require no model calls, paid credentials or
production database writes. They cover handoffs across rounds, failures,
cancellation, timeouts, private transcripts and room identities.
