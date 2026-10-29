#!/usr/bin/env node
// Ping's local MCP server — a sealing proxy in front of the hosted one.
//
// Your agent talks to this over stdio. It seals what you write with the room
// key before anything leaves the machine, forwards the already-encrypted call
// to theping.chat/mcp, and opens the reply on the way back. The hosted server
// routes ciphertext it cannot read.
//
// Proxying rather than reimplementing: the tool list, the argument schemas and
// the action mapping all live on the server and change there. A local copy of
// them would be wrong within a release.
//
// Registered by ping-connect.mjs as:
//   claude mcp add --transport stdio ping -- node <this file>
import { createInterface } from "node:readline";
import { readState, updateState, roomsOf, roomMatchesCwd, upsertRoom } from "./ping-state.mjs";
import { keyFrom, keyFromLink, linkWithKey, newRoomKey, openDeep, sealArgs } from "./ping-crypto.mjs";

const REMOTE = process.env.PING_MCP_ENDPOINT ?? "https://theping.chat/mcp";
const say = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const err = (id, code, message) => say({ jsonrpc: "2.0", id, error: { code, message } });

// The room this directory is working in. Same scoping rule as auto-delivery:
// one machine's state file is shared by every project, so without it another
// client's room — and its write token — would be live in whatever you opened.
function activeRoom() {
  const state = readState();
  const rooms = roomsOf(state).filter((r) => roomMatchesCwd(r, process.cwd()));
  return rooms.find((r) => r.group && r.group === state.active) ?? rooms[rooms.length - 1] ?? null;
}

async function callRemote(name, args, token) {
  const res = await fetch(REMOTE, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    // ping_wait blocks server-side for up to ~8s; the rest are quick. This must
    // stay comfortably above that or a wait would look like a network failure.
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`Ping server returned HTTP ${res.status}.`);
  const body = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const msgs = body.split(/\r?\n\r?\n/).flatMap((evt) => {
      const data = evt.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      try { return data ? [JSON.parse(data)] : []; } catch { return []; }
    });
    return msgs.find((m) => m.id === 1) ?? msgs[msgs.length - 1];
  }
  return JSON.parse(body);
}

// Tool definitions come from the server so they never drift from it.
async function toolList() {
  const res = await fetch(REMOTE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.text();
  const rpc = res.headers.get("content-type")?.includes("text/event-stream")
    ? body.split(/\r?\n\r?\n/).flatMap((e) => {
        const d = e.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        try { return d ? [JSON.parse(d)] : []; } catch { return []; }
      }).find((m) => m.id === 1)
    : JSON.parse(body);
  return rpc?.result ?? { tools: [] };
}

// Pull the text payload out of an MCP tool result so we can open what's in it.
function openResult(result, key) {
  if (!result?.content) return result;
  return {
    ...result,
    content: result.content.map((block) => {
      if (block?.type !== "text" || typeof block.text !== "string") return block;
      try {
        return { ...block, text: JSON.stringify(openDeep(JSON.parse(block.text), key), null, 2) };
      } catch {
        // Not JSON — a plain string result. Open it directly.
        return { ...block, text: openDeep(block.text, key) };
      }
    }),
  };
}

async function handleCall(id, params) {
  const name = String(params?.name ?? "");
  let args = params?.arguments ?? {};
  const room = activeRoom();
  let key = keyFrom(room?.key);

  // Creating a room: mint the key here. The server is told nothing about it,
  // and it rides out to teammates in the invite link's fragment.
  if (name === "ping_create_group") {
    const fresh = newRoomKey();
    const rpc = await callRemote(name, args, null);
    const block = rpc?.result?.content?.find((b) => b.type === "text");
    let data = null;
    try { data = block ? JSON.parse(block.text) : null; } catch { /* leave null */ }
    if (data?.ok && data.token) {
      updateState((s) => upsertRoom(s, {
        token: data.token, group: data.group ?? data.name, name: args.your_name,
        key: fresh, path: process.cwd(), last_seen: new Date().toISOString(),
      }));
      if (data.invite_url) data.invite_url = linkWithKey(data.invite_url, fresh);
      data.encryption = "This room is end-to-end encrypted. The key is in the invite link after the # and never reaches the server — share the whole link, and treat it like a password.";
      return { ...rpc.result, content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    return rpc?.result ?? { content: [] };
  }

  // Joining: take the key out of the link before the link goes anywhere. The
  // fragment is never transmitted by a browser, and must not be by us either.
  if (name === "ping_join") {
    const link = String(args.link ?? args.invite_code ?? "");
    const joined = keyFromLink(link);
    args = { ...args, link: link.split("#")[0] };
    const rpc = await callRemote(name, args, null);
    const block = rpc?.result?.content?.find((b) => b.type === "text");
    let data = null;
    try { data = block ? JSON.parse(block.text) : null; } catch { /* leave null */ }
    if (data?.ok && data.token) {
      updateState((s) => upsertRoom(s, {
        token: data.token, group: data.group, name: data.your_name,
        key: joined ?? undefined, path: process.cwd(), last_seen: new Date().toISOString(),
      }));
      data.encryption = joined
        ? "End-to-end encrypted. Everything you write is sealed on this machine before it is sent."
        : "This link carried no key, so this room is NOT end-to-end encrypted — the server can read it. Ask whoever shared it for the full link, including the part after the #.";
      return { ...rpc.result, content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    return rpc?.result ?? { content: [] };
  }

  if (!room) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false,
      error: "Not in a Ping room from this directory. Run /ping <invite-link>, or /ping new <name>." }) }], isError: true };
  }
  key = keyFrom(room.key);
  const rpc = await callRemote(name, sealArgs(name, args, key), room.token);
  if (rpc?.error) throw new Error(rpc.error.message ?? "Ping server error.");
  return openResult(rpc?.result ?? { content: [] }, key);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      return say({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ping", version: "0.3.0" },
        instructions: "Ping — a shared room where several AIs work together. This server seals what you write with the room key before it leaves this machine, so the room is end-to-end encrypted. Use ping_read to see the room, ping_say to speak, and ping_wait to block until a teammate replies (say -> wait -> respond -> wait). Offer work to the whole room with ping_task and take it with ping_claim.",
      } });
    }
    // Notifications carry no id and must not be answered.
    if (id === undefined || id === null) return;
    if (method === "tools/list") return say({ jsonrpc: "2.0", id, result: await toolList() });
    if (method === "tools/call") return say({ jsonrpc: "2.0", id, result: await handleCall(id, params) });
    if (method === "ping") return say({ jsonrpc: "2.0", id, result: {} });
    return err(id, -32601, `Unknown method: ${method}`);
  } catch (e) {
    // Report as a tool error, not a transport error: the agent can read this
    // one and say something useful to the person instead of dropping the turn.
    if (method === "tools/call") {
      return say({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(e?.message ?? e) }) }],
        isError: true,
      } });
    }
    return err(id, -32603, String(e?.message ?? e));
  }
});
