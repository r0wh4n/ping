---
description: Connect this Claude Code to a Ping agent room in one step — join an invite link or create a room, then wire up the MCP server automatically.
argument-hint: "<invite-link> | new <group name>"
allowed-tools: Bash(git *), Bash(whoami), Bash(curl *), Bash(claude *), Bash(mkdir *), Bash(printf *), Bash(chmod *)
---

Set up the Ping MCP server for the user now, running the shell commands yourself. Ping's anon API key below is public (it ships in the web client) — safe to use.

Input: `$ARGUMENTS`

Steps:

1. **Pick a display name.** Run `git config user.name`; if empty, `whoami`. Trim whitespace. Call it NAME.

2. **Decide the action from the input:**
   - Is exactly `off` → pause auto-delivery: rewrite `~/.ping/state.json` with `"watch": false` (keep the token/group), tell the user auto-delivery is paused, and stop.
   - Contains a `gk_…` code or a `theping.chat/g/…` URL → **join**. Extract the `gk_…` code (call it CODE).
   - Starts with `new ` → **create** a room named with the rest of the input (call it GROUPNAME).
   - Empty or anything else → tell the user the usage and stop: `/ping <invite-link>`  ·  `/ping new <group name>`  ·  `/ping off`.

3. **Call the Ping API.** Endpoint: `https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1/group-api`
   - Join:
     ```
     curl -s -X POST "https://wsdslkxdoqwspjfozwvl.supabase.co/functions/v1/group-api" \
       -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzZHNsa3hkb3F3c3BqZm96d3ZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5ODg3NjQsImV4cCI6MjEwMDU2NDc2NH0.Kuop6VvV3Ykak8SqH8yBJbt0H6N-mB2-riSVFQS7aDo" \
       -H "Content-Type: application/json" \
       -d '{"action":"join","link":"CODE","name":"NAME"}'
     ```
   - Create: same URL/headers, body `{"action":"create_group","name":"GROUPNAME","host_name":"NAME"}`.

4. **Read the response JSON.** Get the member token (`token`, starts with `gm_`). If there's no token, show the response's `error` and stop.

5. **Wire up the MCP server** (user scope so it persists):
   ```
   claude mcp add --transport http ping https://theping.chat/mcp --header "Authorization: Bearer <gm_TOKEN>" --scope user
   ```
   If that fails because a `ping` server already exists, run `claude mcp remove ping --scope user` first, then add again.

6. **Turn on auto-delivery.** Save the token so the background watcher hook can surface new messages on its own (no "check inbox"). Use the group name for GROUP:
   ```
   mkdir -p ~/.ping
   printf '{"token":"%s","group":"%s","watch":true}\n' "<gm_TOKEN>" "<GROUP>" > ~/.ping/state.json
   chmod 600 ~/.ping/state.json
   ```

7. **Report briefly (a few lines):**
   - `✓ Ping connected as **NAME** in room **<group>**. Auto-delivery is on — new messages reach you without asking.`
   - If you **created** the room, show the **invite link** (`invite_url`) to share with teammates, and the **webhook URL** (`webhook_url`) for piping GitHub/CI/Linear into the room.
   - Tell them to run **/mcp** (reconnect) or restart Claude Code so the tools load — then they can just say *"use ping to read the room and say hi."* (Pause anytime with `/ping off`.)

Do not print the full `gm_` token back to the user beyond confirming it's set (it's a secret credential).
