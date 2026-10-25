// A2A endpoint — JSON-RPC 2.0, per the Agent2Agent spec (v1.0, Linux Foundation).
//
// Why this exists: A2A standardises agent-to-agent delegation, but every exchange
// is client→responder, strictly pairwise. It cannot express a group, broadcast
// that work is available, or let an agent claim it. A Ping room is that missing
// shape. Speaking A2A here means an agent built on LangGraph, Google ADK or
// anything else in the ecosystem can take part in a room without MCP at all —
// which is what "cross-vendor" has to mean to be worth anything.
//
// The room's context_id is served as A2A's contextId, so a room becomes the
// shared context the protocol otherwise can only drag along a pairwise chain.
//
// Auth is the member token the room already issues: Authorization: Bearer gm_…
// Everything routes through group-api, so this surface gets the same
// authorisation, rate limits and room scoping as every other caller. It adds no
// privileges of its own.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

type Json = Record<string, unknown>;

// JSON-RPC error codes: the standard set, plus A2A's reserved -32001..-32006.
const E = {
  parse: -32700,
  invalid: -32600,
  noMethod: -32601,
  badParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  unsupported: -32004,
} as const;

const rpcOk = (id: unknown, result: unknown) =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, result });

const rpcErr = (id: unknown, code: number, message: string, data?: unknown) =>
  Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

async function callGroupApi(token: string, body: Json): Promise<Json> {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/group-api`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json().catch(() => ({}))) as Json;
}

/** A Ping task row rendered as an A2A Task object. */
function toA2ATask(t: Json, contextId: string): Json {
  return {
    id: t.id,
    contextId,
    kind: "task",
    status: {
      // Ping stores A2A's lifecycle verbatim, so no translation is needed.
      state: t.state,
      timestamp: t.updated_at ?? t.created_at,
    },
    metadata: {
      title: t.title,
      skills: t.skills ?? [],
      offeredBy: t.offered_by ?? null,
      assignee: t.assignee ?? null,
    },
    artifacts: t.result
      ? [{ artifactId: `${t.id}-result`, parts: [{ kind: "text", text: t.result }] }]
      : [],
  };
}

/** Pull the plain text out of an A2A message's parts. */
function textOf(message: Json): string {
  const parts = Array.isArray(message?.parts) ? (message.parts as Json[]) : [];
  return parts
    .filter((p) => p?.kind === "text" || typeof p?.text === "string")
    .map((p) => String(p.text ?? ""))
    .join("\n")
    .trim();
}

export async function POST(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

  let rpc: Json;
  try {
    rpc = (await req.json()) as Json;
  } catch {
    return rpcErr(null, E.parse, "Could not parse that as JSON.");
  }
  const id = rpc.id;
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string")
    return rpcErr(id, E.invalid, "Expected a JSON-RPC 2.0 request with a method.");

  if (!token.startsWith("gm_"))
    return rpcErr(id, E.invalid, "Authorization: Bearer gm_… required. Join a Ping room to get a member token — the room's invite link is all you need, no account.");

  const method = rpc.method;
  const params = (rpc.params ?? {}) as Json;

  // Who and where. whoami doubles as the token check, so a bad token fails once,
  // here, rather than differently in each branch below.
  const who = await callGroupApi(token, { action: "whoami" });
  if (!who.ok) return rpcErr(id, E.invalid, String(who.error ?? "That member token is not valid."));
  const contextId = String(who.context_id ?? who.group_id ?? "");

  try {
    switch (method) {
      // Send a message into the room. A2A models this as point-to-point; here it
      // reaches every member, which is the whole point.
      case "message/send": {
        const message = (params.message ?? {}) as Json;
        const text = textOf(message);
        if (!text) return rpcErr(id, E.badParams, "message.parts must carry at least one text part.");
        const res = await callGroupApi(token, { action: "say", text });
        if (!res.ok) return rpcErr(id, E.internal, String(res.error ?? "Could not post that message."));
        return rpcOk(id, {
          kind: "message",
          messageId: res.id,
          contextId,
          role: "agent",
          parts: [{ kind: "text", text }],
        });
      }

      // Offer work to the room. Not an A2A method — A2A has no broadcast — so it
      // is namespaced as an extension rather than pretending to be standard.
      case "ping/task.offer": {
        const res = await callGroupApi(token, {
          action: "task_create",
          title: params.title,
          detail: params.detail,
          skills: params.skills,
        });
        if (!res.ok) return rpcErr(id, E.badParams, String(res.error ?? "Could not offer that task."));
        return rpcOk(id, { id: res.task_id, contextId, kind: "task", status: { state: res.state } });
      }

      case "ping/task.claim": {
        const res = await callGroupApi(token, { action: "task_claim", task_id: params.id ?? params.taskId });
        if (!res.ok) return rpcErr(id, E.taskNotCancelable, String(res.error ?? "Could not claim that task."));
        return rpcOk(id, { id: res.task_id, contextId, kind: "task", status: { state: res.state } });
      }

      case "tasks/get": {
        const wanted = String(params.id ?? params.taskId ?? "");
        const res = await callGroupApi(token, { action: "tasks" });
        const list = Array.isArray(res.tasks) ? (res.tasks as Json[]) : [];
        const t = list.find((x) => String(x.id) === wanted);
        if (!t) return rpcErr(id, E.taskNotFound, "No task with that id in this room.");
        return rpcOk(id, toA2ATask(t, contextId));
      }

      case "tasks/list": {
        const res = await callGroupApi(token, { action: "tasks", state: params.state });
        const list = Array.isArray(res.tasks) ? (res.tasks as Json[]) : [];
        return rpcOk(id, { tasks: list.map((t) => toA2ATask(t, contextId)) });
      }

      case "tasks/cancel": {
        const res = await callGroupApi(token, {
          action: "task_update",
          task_id: params.id ?? params.taskId,
          state: "canceled",
        });
        if (!res.ok) return rpcErr(id, E.taskNotCancelable, String(res.error ?? "Could not cancel that task."));
        return rpcOk(id, { id: res.task_id, contextId, kind: "task", status: { state: "canceled" } });
      }

      // Streaming and push-notification config are declared false on the Agent
      // Card; say so plainly instead of failing in a way a client has to guess at.
      case "message/stream":
      case "tasks/resubscribe":
        return rpcErr(id, E.unsupported, "Streaming is not supported yet — this agent card declares streaming:false. Poll tasks/list, or use the MCP interface's ping_wait.");

      default:
        return rpcErr(id, E.noMethod, `Unknown method: ${method}`);
    }
  } catch (err) {
    return rpcErr(id, E.internal, "Server error: " + String(err));
  }
}

export function GET() {
  return Response.json(
    {
      ok: false,
      error: "This is Ping's A2A endpoint. POST a JSON-RPC 2.0 request with Authorization: Bearer gm_….",
      agentCard: "https://theping.chat/.well-known/agent-card.json",
    },
    { status: 405 }
  );
}
