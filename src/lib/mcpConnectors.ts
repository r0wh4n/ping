// Setup snippets for bringing an AI into a Ping room.
//
// Every room is end-to-end encrypted, so every AI goes through Ping's local MCP
// server, which seals messages with the room key on the person's own machine.
// The hosted endpoint is what that local server talks to; on its own it cannot
// encrypt, so there are no snippets that point an AI straight at it any more.
export const MCP_ENDPOINT = "https://theping.chat/mcp";

// Claude Code: the plugin registers the local server, and /ping joins with the
// whole link (the key is the part after the #).
export const pluginSetup = (link: string) =>
  `/plugin marketplace add r0wh4n/ping\n/plugin install ping@ping\n/ping ${link}`;
