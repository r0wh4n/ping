import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Incoming webhook for agent groups. External tools (GitHub / CI / Linear / curl)
// POST here; the event is formatted and posted into the group timeline as a bot
// message, so every member's AI sees it via ping_read. Auth = the per-group
// secret webhook token (wh_...), passed by the /hook/<token> Next route.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-ping-token, x-github-event",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type P = any;
const repoOf = (p: P) => (p?.repository?.name ? String(p.repository.name) : "repo");

function formatGithub(event: string, p: P): string {
  const repo = repoOf(p);
  switch (event) {
    case "ping": return "";
    case "push": {
      const n = Array.isArray(p?.commits) ? p.commits.length : 0;
      const branch = String(p?.ref ?? "").replace("refs/heads/", "") || "a branch";
      const who = p?.pusher?.name ?? p?.sender?.login ?? "someone";
      if (n === 0) return "";
      return `${repo}: ${who} pushed ${n} commit${n === 1 ? "" : "s"} to ${branch}`;
    }
    case "pull_request": {
      const merged = p?.action === "closed" && p?.pull_request?.merged;
      const act = merged ? "merged" : String(p?.action ?? "updated");
      return `${repo}: PR #${p?.number} ${act} — ${p?.pull_request?.title ?? ""}`.trim();
    }
    case "workflow_run": {
      if (p?.action !== "completed") return "";
      const c = p?.workflow_run?.conclusion ?? "finished";
      const b = p?.workflow_run?.head_branch ?? "";
      const mark = c === "success" ? "✓" : c === "failure" ? "✗" : "";
      return `${repo}: CI ${c} ${mark} on ${b}`.trim();
    }
    case "issues":
      return `${repo}: issue #${p?.issue?.number} ${p?.action} — ${p?.issue?.title ?? ""}`.trim();
    case "release":
      return p?.action === "published" ? `${repo}: released ${p?.release?.tag_name ?? ""}`.trim() : "";
    case "star":
    case "watch":
      return `${repo}: new star ⭐ from ${p?.sender?.login ?? "someone"}`;
    case "deployment_status":
      return `${repo}: deploy ${p?.deployment_status?.state ?? ""}`.trim();
    default:
      return "";
  }
}

function formatLinear(p: P): string {
  const d = p?.data ?? {};
  const id = d?.identifier ?? d?.number ?? "item";
  const title = d?.title ?? "";
  const state = d?.state?.name ? ` → ${d.state.name}` : "";
  return `Linear: ${id} ${p?.action ?? "updated"} — ${title}${state}`.trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const url = new URL(req.url);
    const token = (req.headers.get("x-ping-token") || url.searchParams.get("token") || "").trim();
    if (!token.startsWith("wh_")) return json({ ok: false, error: "Missing webhook token." }, 401);

    const { data: g } = await admin.from("agent_groups").select("id").eq("webhook_token", token).maybeSingle();
    if (!g) return json({ ok: false, error: "Unknown webhook." }, 404);

    const ghEvent = (req.headers.get("x-github-event") || "").trim();
    const payload: P = await req.json().catch(() => ({}));

    let source = "webhook";
    let text = "";
    if (ghEvent) {
      source = "github";
      text = formatGithub(ghEvent, payload);
    } else if (payload && payload.action && (payload.data || payload.type) && !payload.text) {
      source = "linear";
      text = formatLinear(payload);
    } else if (typeof payload?.text === "string") {
      text = payload.text;
      source = String(payload.source ?? "webhook").slice(0, 24).replace(/[^a-zA-Z0-9_.-]/g, "") || "webhook";
    }

    if (!text.trim()) return json({ ok: true, skipped: true }); // unhandled/ping event
    text = text.slice(0, 2000);

    const { error } = await admin
      .from("agent_group_messages")
      .insert({ group_id: g.id, member_id: null, kind: "event", source, body: text });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, posted: text });
  } catch (e) {
    return json({ ok: false, error: "Server error: " + String(e) }, 500);
  }
});
