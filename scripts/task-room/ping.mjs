import { clean } from "./agents.mjs";

// Talks to Ping's existing stateless MCP endpoint. No Supabase service key or
// client-specific MCP config is needed; membership credentials stay in memory.
export class PingRoom {
  #tokens = new Map();
  #seen = new Set();
  #requestId = 0;
  #groupId;

  constructor({ link, endpoint = "https://theping.chat/mcp" }) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.hash || url.search ||
        !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new Error("MCP endpoint must use HTTPS (HTTP is allowed on loopback), without credentials, query or fragment.");
    }
    if (typeof link !== "string" || !/^(?:gk_[A-Za-z0-9_-]+|https?:\/\/[^\s]+\/g\/gk_[A-Za-z0-9_-]+)$/.test(link)) {
      throw new Error("Pass a Ping room invite link or gk_ code to --room.");
    }
    this.endpoint = url.href;
    this.link = link;
  }

  async #call(name, args, token, signal, timeout = 15000) {
    const id = ++this.#requestId;
    const response = await fetch(this.endpoint, {
      method: "POST", redirect: "error",
      headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`Ping MCP HTTP ${response.status}.`);
    let body = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      body += decoder.decode(chunk, { stream: true });
      if (body.length > 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error("Ping MCP response exceeds 1 MiB."); }
    }
    body += decoder.decode();
    let rpc;
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const messages = body.split(/\r?\n\r?\n/).flatMap((event) => {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        try { return data ? [JSON.parse(data)] : []; } catch { return []; }
      });
      rpc = messages.find((message) => message.id === id);
    } else rpc = JSON.parse(body);
    if (!rpc || rpc.id !== id || rpc.error) throw new Error("Ping MCP returned an invalid or failed JSON-RPC response.");
    const content = rpc.result?.content?.find((block) => block.type === "text");
    const data = content ? JSON.parse(content.text) : null;
    if (!data || data.ok !== true || rpc.result?.isError) throw new Error(clean(data?.error || "Ping MCP tool failed."));
    return data;
  }

  async open(agents, signal) {
    for (const agent of agents) {
      const data = await this.#call("ping_join", { link: this.link, name: agent.id }, null, signal);
      if (typeof data.token !== "string" || !/^gm_[A-Za-z0-9_-]+$/.test(data.token)) throw new Error("Ping did not return a member credential.");
      this.#tokens.set(agent.id, data.token);
      if (!data.group_id || (this.#groupId && this.#groupId !== data.group_id)) throw new Error("Ping joined a different room; stopping before sharing context.");
      this.#groupId = data.group_id;
    }
  }

  async read(signal) {
    const token = this.#tokens.values().next().value;
    const data = await this.#call("ping_history", { limit: 50 }, token, signal);
    const messages = [];
    for (const message of data.messages || []) {
      if (!message?.id || this.#seen.has(message.id)) continue;
      this.#seen.add(message.id);
      if (typeof message.text === "string") messages.push({ agent: clean(message.from || "room"), text: clean(message.text).slice(0, 12000) });
    }
    return messages;
  }

  async say(agent, text, signal) {
    const suffix = "\n[Reply shortened; the full reply is in the local transcript.]";
    const content = text.length > 8000 ? text.slice(0, 8000 - suffix.length) + suffix : text;
    const data = await this.#call("ping_say", { text: content }, this.#tokens.get(agent), signal);
    if (data.id) this.#seen.add(data.id);
  }

  async close() {
    const failures = [];
    for (const [agent, token] of this.#tokens) {
      try { await this.#call("ping_leave", {}, token, undefined, 3000); }
      catch { failures.push(agent); }
    }
    this.#tokens.clear();
    if (failures.length) throw new Error(`Could not remove temporary Ping memberships: ${failures.join(", ")}.`);
  }
}
