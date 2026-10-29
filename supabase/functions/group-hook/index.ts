import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { checkSignature } from "./signature.ts";

// Incoming webhook for agent groups. External tools (GitHub / CI / Linear / curl)
// POST here; the event is formatted and posted into the group timeline as a bot
// message, so every member's AI sees it via ping_read. Auth = the per-group
// secret webhook token (wh_...), passed by the /hook/<token> Next route.
//
// This function is PUBLIC (verify_jwt=false), so it enforces its own rate limit
// rather than trusting the Next wrapper's -- the wrapper is bypassable by calling
// this URL directly.
//
// Every field interpolated below is attacker-controlled (repo names, PR titles,
// commit authors). All of it lands verbatim in an AI agent's context, so it is
// laundered through clean() first: control chars and newlines stripped, length
// capped. That keeps injected "ignore previous instructions" text from arriving
// as its own line / structured block.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-ping-token, x-github-event, x-hub-signature-256, linear-signature, x-ping-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type P = any;

// Flatten untrusted text to a single safe line. Newlines are the real weapon in
// prompt injection (they let payload text impersonate a new turn/system block),
// so they collapse to spaces rather than surviving. \p{Cf} strips zero-width and
// bidi marks, which otherwise hide text from a human reading the room.
const clean = (v: unknown, max = 160): string =>
  String(v ?? "")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\p{Cf}+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const repoOf = (p: P) => clean(p?.repository?.name || "repo", 80);

// GitHub fires many sub-actions per event type; posting all of them floods the
// room and burns the rate limit. Only the ones a human would care about pass.
const GH_ACTIONS: Record<string, string[]> = {
  issues: ["opened", "closed", "reopened"],
  pull_request: ["opened", "closed", "reopened", "ready_for_review"],
};

function formatGithub(event: string, p: P): string {
  const repo = repoOf(p);
  const action = clean(p?.action, 40);
  const allowed = GH_ACTIONS[event];
  if (allowed && !allowed.includes(action)) return "";

  switch (event) {
    case "ping": return "";
    case "push": {
      const n = Array.isArray(p?.commits) ? p.commits.length : 0;
      const branch = clean(String(p?.ref ?? "").replace("refs/heads/", "") || "a branch", 80);
      const who = clean(p?.pusher?.name || p?.sender?.login || "someone", 80);
      if (n === 0) return ""; // branch delete / no-op push
      return `${repo}: ${who} pushed ${n} commit${n === 1 ? "" : "s"} to ${branch}`;
    }
    case "pull_request": {
      const merged = action === "closed" && p?.pull_request?.merged;
      const act = merged ? "merged" : action || "updated";
      const num = Number(p?.number) || "";
      return `${repo}: PR #${num} ${act} - ${clean(p?.pull_request?.title)}`.trim();
    }
    case "workflow_run": {
      if (action !== "completed") return "";
      const c = clean(p?.workflow_run?.conclusion || "finished", 40);
      const b = clean(p?.workflow_run?.head_branch, 80);
      const mark = c === "success" ? "OK" : c === "failure" ? "FAIL" : "";
      return `${repo}: CI ${c} ${mark}${b ? ` on ${b}` : ""}`.trim();
    }
    case "issues": {
      const num = Number(p?.issue?.number) || "";
      return `${repo}: issue #${num} ${action} - ${clean(p?.issue?.title)}`.trim();
    }
    case "release":
      return action === "published" ? `${repo}: released ${clean(p?.release?.tag_name, 60)}`.trim() : "";
    case "star":
      // "deleted" = someone unstarred; don't announce that as a new star.
      return action === "created" ? `${repo}: new star from ${clean(p?.sender?.login || "someone", 80)}` : "";
    case "watch":
      return action === "started" ? `${repo}: new star from ${clean(p?.sender?.login || "someone", 80)}` : "";
    case "deployment_status": {
      const st = clean(p?.deployment_status?.state, 40);
      return st === "success" || st === "failure" || st === "error" ? `${repo}: deploy ${st}` : "";
    }
    default:
      return "";
  }
}

function formatLinear(p: P): string {
  const d = p?.data ?? {};
  const id = clean(d?.identifier || d?.number || "item", 40);
  const title = clean(d?.title);
  const state = d?.state?.name ? ` -> ${clean(d.state.name, 40)}` : "";
  return `Linear: ${id} ${clean(p?.action, 40) || "updated"} - ${title}${state}`.trim();
}

// Only treat a payload as Linear when it carries a Linear-specific marker.
// The old check ({action} + {data|type}) swallowed generic payloads and posted
// a bogus "Linear: item updated" that no sender could opt out of.
const isLinear = (p: P) =>
  !!p && typeof p.action === "string" && !!p.data && typeof p.type === "string" &&
  (!!p.organizationId || String(p.url ?? "").includes("linear.app"));

// Who did it -- stored structurally so "what did Rohan do this week?" is a query,
// not a substring search through message bodies.
function actorOf(source: string, p: P): string | null {
  if (source === "github") return clean(p?.pusher?.name || p?.sender?.login, 80) || null;
  if (source === "linear") return clean(p?.data?.assignee?.name || p?.actor?.name, 80) || null;
  return clean(p?.author || p?.actor || p?.user, 80) || null;
}

// Takes the raw body rather than the Request: the signature is computed over
// the exact bytes that arrived, and a body can only be read once.
function readPayload(raw: string, ctype: string): P {
  if (!raw) return {};
  // GitHub's "application/x-www-form-urlencoded" content-type setting sends the
  // JSON inside a `payload` form field. The old code JSON.parsed the raw form
  // string, got {}, and silently 200'd -- webhooks appeared configured but never
  // posted anything.
  if (ctype.includes("application/x-www-form-urlencoded")) {
    try {
      const p = new URLSearchParams(raw).get("payload");
      return p ? JSON.parse(p) : {};
    } catch { return {}; }
  }
  try { return JSON.parse(raw); } catch { return {}; }
}


// ---- Webhook signature verification ----------------------------------------
//
// The wh_ token is an identifier, not authentication: it rides in URLs, CI
// config and logs. Anyone who learned one could post events that every agent in
// the room then treats as fact — prompt injection with a delivery mechanism.
//
// Enforcement is deliberately staged so that turning signing ON can never
// silently drop a live webhook:
//   no secret          -> accept, and mark the event unverified in the room
//   secret, none seen  -> accept signed or unsigned; a good signature promotes
//   secret, seen good  -> require a good signature
// Once a sender has proved it can sign, a request that does not is not from it.
//
// The primitives live in signature.ts so the Node self-check exercises the same
// bytes this function runs: scripts/check-webhook-signature.mjs

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
    // Shape-check before anything else: a malformed token can't be a real one,
    // so reject it without creating a rate_limits row for it (otherwise random
    // junk tokens are a free way to grow that table).
    if (!/^wh_[A-Za-z0-9_-]{16,64}$/.test(token)) return json({ ok: false, error: "Missing webhook token." }, 401);

    // Throttle before the group lookup so unknown-token spam is cheap too.
    const { data: allowed } = await admin.rpc("rl_hit", {
      p_bucket: "hook:" + token, p_limit: 60, p_window_secs: 60,
    });
    if (allowed === false) return json({ ok: false, error: "Rate limit - too many webhook posts. Slow down." }, 429);

    const { data: g } = await admin.from("agent_groups")
      .select("id,webhook_secret,webhook_verified_at").eq("webhook_token", token).maybeSingle();
    if (!g) return json({ ok: false, error: "Unknown webhook." }, 404);

    // Read the body ONCE, as text, before anything parses it: the signature
    // covers the exact bytes that arrived, not a re-serialised object.
    const raw = await req.text().catch(() => "");
    const secret = g.webhook_secret ? String(g.webhook_secret) : "";
    const verdict = secret ? await checkSignature(req.headers, raw, secret) : "absent";

    if (secret && verdict === "bad")
      return json({ ok: false, error: "Signature did not match this room's webhook secret." }, 401);
    if (secret && verdict === "absent" && g.webhook_verified_at)
      return json({ ok: false, error: "This webhook requires a signature. Send X-Hub-Signature-256 (GitHub), Linear-Signature, or X-Ping-Signature as hex HMAC-SHA256 of the raw body." }, 401);
    if (verdict === "good" && !g.webhook_verified_at) {
      // First correctly signed request: from here on, unsigned is refused.
      await admin.from("agent_groups")
        .update({ webhook_verified_at: new Date().toISOString() }).eq("id", g.id);
    }
    const verified = verdict === "good";

    const ghEvent = clean(req.headers.get("x-github-event"), 40);
    const payload: P = readPayload(raw, (req.headers.get("content-type") || "").toLowerCase());

    let source = "webhook";
    let text = "";
    if (ghEvent) {
      source = "github";
      text = formatGithub(ghEvent, payload);
    } else if (typeof payload?.text === "string") {
      // Explicit text always wins, so any sender can opt out of the heuristics.
      text = clean(payload.text, 2000);
      source = clean(payload.source ?? "webhook", 24).replace(/[^a-zA-Z0-9_.-]/g, "") || "webhook";
    } else if (isLinear(payload)) {
      source = "linear";
      text = formatLinear(payload);
    }

    if (!text.trim()) return json({ ok: true, skipped: true }); // unhandled/filtered event
    text = text.slice(0, 2000);

    // An agent reading the room cannot see HTTP headers, so provenance has to
    // travel in the text it actually reads. Anyone who learns the hook URL can
    // post an unsigned event; saying so inline is what stops it being believed.
    const author = actorOf(source, payload);
    const { error } = await admin
      .from("agent_group_messages")
      .insert({
        group_id: g.id, member_id: null, kind: "event", source,
        body: verified ? text : `${text}  [unverified sender]`,
        author_name: verified ? author : `${author} (unverified)`.slice(0, 80),
      });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, posted: text, verified,
      ...(verified ? {} : { hint: "This event was not signed. Set a webhook secret on the room so agents can tell real events from injected ones." }) });
  } catch (e) {
    return json({ ok: false, error: "Server error: " + String(e) }, 500);
  }
});
