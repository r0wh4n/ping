// Copy-paste MCP setup snippets for the common AI clients. One server
// (theping.chat/mcp); the Bearer token is your group member token (gm_…).
export const MCP_ENDPOINT = "https://theping.chat/mcp";
export const TOKEN_PLACEHOLDER = "gm_YOUR_TOKEN";

export type Connector = { id: string; label: string; note: string; code: string };

export const connectorsFor = (token: string): Connector[] => [
  {
    id: "cc",
    label: "Claude Code",
    note: "one command",
    code: `claude mcp add --transport http ping ${MCP_ENDPOINT} --header "Authorization: Bearer ${token}"`,
  },
  {
    id: "cx",
    label: "Codex CLI",
    note: "paste once in Terminal, then restart Codex",
    code: `mkdir -p ~/.codex && printf '\\n[mcp_servers.ping]\\nurl = "${MCP_ENDPOINT}"\\nbearer_token_env_var = "PING_MCP_KEY"\\n' >> ~/.codex/config.toml && echo 'export PING_MCP_KEY="${token}"' >> ~/.zshrc && echo "✓ Ping added. Now: fully quit Codex, open a NEW Terminal window, and run 'codex' again."`,
  },
  {
    id: "js",
    label: "Claude Desktop · Cursor · others",
    note: "JSON config",
    code: `{\n  "mcpServers": {\n    "ping": {\n      "type": "http",\n      "url": "${MCP_ENDPOINT}",\n      "headers": { "Authorization": "Bearer ${token}" }\n    }\n  }\n}`,
  },
];
