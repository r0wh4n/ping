import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Ping for Agents v2 — groups. One invite link (gk_) joins a group; each member
// gets a keyless member token (gm_) used as the MCP bearer. Chat + shared context
// live in one timeline. Groups also have an incoming webhook (wh_) for GitHub/CI/
// Linear. ping_wait long-polls so agents hold a live back-and-forth without polling.
// A web owner (Supabase JWT) can read/digest/note their OWN groups (owner path).

const SITE = "https://theping.chat";

// Server-side synthesis for ping_catchup/ping_digest is OPTIONAL.
// - No key set (default): the tool returns the raw timeline + instructions and the
//   CALLING agent (Claude/Codex/…) summarizes it on ITS OWN subscription — no key,
//   no cost, more private. Main path when Ping is used from inside an AI.
// - Key set: the SERVER generates the digest (needed for the web page, which has no
//   agent). OpenAI-compatible — ANY provider (OpenAI, OpenRouter, Groq, Together, local).
const LLM_KEY = Deno.env.get("LLM_API_KEY") ?? "";
const LLM_BASE = (Deno.env.get("LLM_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const LLM_MODEL = Deno.env.get("LLM_MODEL") ?? "gpt-4o-mini";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-agent-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Admin = ReturnType<typeof createClient>;
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = (n: number) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); };
const newInvite = () => "gk_" + rand(9);
const newMemberToken = () => "gm_" + rand(24);
const newWebhook = () => "wh_" + rand(18);
const cleanName = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
const inviteFrom = (s: unknown) => {
  const t = String(s ?? "").trim();
  const m = t.match(/gk_[A-Za-z0-9_-]+/);
  return m ? m[0] : "";
};

// An invite link is a bearer credential, so it needs two off-switches: revoked
// outright, or aged out. NULL in both columns means "no limit" — which is exactly
// what every group created before this feature existed keeps.
type InviteState = { invite_revoked_at?: string | null; invite_expires_at?: string | null };
const inviteClosed = (g: InviteState): string | null =>
  g.invite_revoked_at
    ? "This group link has been revoked."
    : g.invite_expires_at && Date.parse(g.invite_expires_at) <= Date.now()
      ? "This group link has expired."
      : null;

async function memberFromToken(admin: Admin, token: string) {
  const { data } = await admin
    .from("agent_group_members").select("id, group_id, name, last_read").eq("token", token).maybeSingle();
  return data;
}
async function groupName(admin: Admin, gid: string): Promise<string | null> {
  const { data } = await admin.from("agent_groups").select("name").eq("id", gid).maybeSingle();
  return data ? String(data.name) : null;
}
async function memberCount(admin: Admin, gid: string): Promise<number> {
  const { count } = await admin
    .from("agent_group_members").select("id", { count: "exact", head: true }).eq("group_id", gid);
  return count ?? 0;
}
// deno-lint-ignore no-explicit-any
async function shape(admin: Admin, rows: any[], meId: string) {
  const ids = [...new Set(rows.map((m) => m.member_id).filter(Boolean))];
  const names: Record<string, string> = {};
  if (ids.length) {
    const { data: ms } = await admin.from("agent_group_members").select("id,name").in("id", ids);
    (ms ?? []).forEach((m) => (names[String(m.id)] = String(m.name)));
  }
  return rows.map((m) => ({
    from: m.author_name ?? (m.member_id ? (names[String(m.member_id)] ?? "?") : (m.source ?? "webhook")),
    mine: m.member_id === meId,
    kind: m.kind, title: m.title, text: m.body, created_at: m.created_at,
  }));
}

const CATCHUP_SYSTEM =
  "You are catching up a teammate's AI agent that just joined an ongoing collaboration room in Ping. Below is the room timeline — chat messages, shared context snapshots, work-log entries, and webhook events, oldest to newest, from several people/agents. Write a tight briefing that takes a newcomer from zero to the full picture, in plain Markdown with these sections: **Current state**, **Decisions made**, **Open questions / blockers**, **Who's doing what**, **Recent activity**. Be concise and concrete, use the participants' names, and omit any section that has nothing in it. If the room is just greetings or nearly empty, say so in a sentence instead of padding. Do not include any internal or system XML tags in your output.";

const digestSystem = (label: string) =>
  `You are writing a work-log digest for a person reviewing what they and their AI agents did in this Ping room over the ${label}. The timeline below is chat, shared context, work-log entries (marked · log), and webhook events (git commits, PRs, CI), oldest to newest. Produce a concise, scannable Markdown digest they can use to recall their work and turn items into tickets, with these sections: **Shipped**, **In progress**, **Decisions**, **Open threads / next**. Under each, list concrete items as short bullets, each phrased like a ticket title — imperative and specific (e.g. "Add rate limiting to the /hook endpoint"). Omit any section with nothing in it. If there's almost nothing in the window, say so in one line. Do not include any internal or system XML tags in your output.`;

// deno-lint-ignore no-explicit-any
function transcriptOf(shaped: any[]): string {
  let lines = shaped.map((m) => {
    const who = m.kind === "context" ? `${m.from} · context` : m.kind === "log" ? `${m.from} · log` : m.from;
    const title = m.title ? ` ${m.title}:` : "";
    const body = m.text.length > 4000 ? m.text.slice(0, 4000) + " …[truncated]" : m.text;
    return `[${who}]${title} ${body}`;
  });
  const MAX = 50000;
  let t = lines.join("\n");
  while (t.length > MAX && lines.length > 1) {
    lines = lines.slice(1);
    t = "[…earlier messages omitted…]\n" + lines.join("\n");
  }
  return t;
}

async function synthesizeServer(group: string, transcript: string, system: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${LLM_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 3000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Room: ${group}\n\n${transcript}` },
      ],
    }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: "Synthesis failed: " + (data?.error?.message ?? `HTTP ${res.status}`) };
  const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
  return { ok: true, text: text || "(No summary produced.)" };
}

// Shared synthesis over a group's timeline (used by the gm_ member path AND the
// web owner path). Read-only. period null = whole room (catchup); else a window.
async function synthOverGroup(admin: Admin, gid: string, group: string, system: string, sinceIso: string | null) {
  let q = admin.from("agent_group_messages")
    .select("id, member_id, author_name, kind, title, body, created_at, source")
    .eq("group_id", gid).order("created_at", { ascending: true }).limit(sinceIso ? 500 : 300);
  if (sinceIso) q = q.gt("created_at", sinceIso);
  const { data: rows } = await q;
  const msgs = rows ?? [];
  if (!msgs.length) return { count: 0 as const };
  const transcript = transcriptOf(await shape(admin, msgs, ""));
  if (!LLM_KEY) return { count: msgs.length, keyless: true as const, instructions: system, timeline: transcript };
  const r = await synthesizeServer(group, transcript, system);
  return { count: msgs.length, keyless: false as const, ok: r.ok, text: r.text, error: r.error };
}
const windowSince = (period: string) => {
  const ms = period === "day" ? 86400000 : period === "month" ? 2592000000 : 604800000;
  return { since: new Date(Date.now() - ms).toISOString(), label: period === "day" ? "last 24 hours" : period === "month" ? "last 30 days" : "last 7 days" };
};

// ---- Rate limiting (DB-backed via rl_hit; fail-open if the RPC errors) ----
const clientIp = (req: Request) =>
  (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
const RL = { create: [10, 3600], join: [20, 3600], post: [60, 60], wait: [40, 60], read: [240, 60] } as const;
async function limited(admin: Admin, bucket: string, spec: readonly [number, number]): Promise<boolean> {
  const { data } = await admin.rpc("rl_hit", { p_bucket: bucket, p_limit: spec[0], p_window_secs: spec[1] });
  return data === false; // true => over the limit
}
const rlError = (what: string) => json({ ok: false, error: `Rate limit — too many ${what}. Wait a bit and retry.` }, 429);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const ip = clientIp(req);

    if (action === "peek") {
      const code = inviteFrom(body.invite_code ?? body.link);
      const { data: g } = await admin.from("agent_groups")
        .select("id,name,invite_expires_at,invite_revoked_at").eq("invite_code", code).maybeSingle();
      if (!g) return json({ ok: false, error: "That group link is invalid." }, 404);
      // 200 with ok:false on purpose: functions-js hides the body on non-2xx, and
      // /g/[code] reads the reason out of res.data.error.
      const closed = inviteClosed(g);
      if (closed) return json({ ok: false, error: closed });
      return json({ ok: true, name: g.name, members: await memberCount(admin, String(g.id)) });
    }

    if (action === "create_group") {
      if (await limited(admin, "create:" + ip, RL.create)) return rlError("groups created");
      const name = cleanName(body.name) || "Untitled group";
      let owner_user: string | null = null;
      if (bearer.startsWith("eyJ")) {
        const { data: u } = await admin.auth.getUser(bearer);
        owner_user = u?.user?.id ?? null;
      }
      const invite_code = newInvite();
      const webhook_token = newWebhook();
      const { data: g, error } = await admin
        .from("agent_groups").insert({ name, invite_code, owner_user, webhook_token })
        .select("id,name,invite_code,webhook_token").single();
      if (error) return json({ ok: false, error: error.message });
      const out: Record<string, unknown> = {
        ok: true, group_id: g.id, name: g.name,
        invite_code: g.invite_code, invite_url: `${SITE}/g/${g.invite_code}`,
        webhook_url: `${SITE}/hook/${g.webhook_token}`,
      };
      const host = cleanName(body.host_name ?? body.your_name);
      if (host) {
        const token = newMemberToken();
        const { data: m } = await admin
          .from("agent_group_members").insert({ group_id: g.id, token, name: host }).select("id").single();
        out.your_name = host;
        out.token = token;
        out.member_id = m?.id;
        out.next_step = `You're in as \"${host}\". Set this as your MCP bearer token (replace your key with ${token}); then use ping_say / ping_wait / ping_read / ping_share / ping_log. Share the invite link so others can join.`;
      }
      return json(out);
    }

    if (action === "join") {
      if (await limited(admin, "join:" + ip, RL.join)) return rlError("join attempts");
      const code = inviteFrom(body.invite_code ?? body.link);
      const name = cleanName(body.name);
      if (!name) return json({ ok: false, error: "Pick a name to join with." });
      const { data: g } = await admin.from("agent_groups")
        .select("id,name,invite_expires_at,invite_revoked_at").eq("invite_code", code).maybeSingle();
      if (!g) return json({ ok: false, error: "That group link is invalid." }, 404);
      const closed = inviteClosed(g);
      if (closed) return json({ ok: false, error: closed });
      const token = newMemberToken();
      const { data: m, error } = await admin
        .from("agent_group_members").insert({ group_id: g.id, token, name }).select("id").single();
      if (error) return json({ ok: false, error: error.message });
      return json({
        ok: true, group_id: g.id, group: g.name, your_name: name, member_id: m.id, token,
        next_step: `Joined \"${g.name}\" as \"${name}\". Set ${token} as your MCP bearer token, then use ping_say / ping_wait / ping_read / ping_share / ping_log.`,
      });
    }

    // Owner dashboard (Mission Control): every room you own with live-ish
    // activity, in one call. JWT only, no group_id.
    if (action === "rooms_overview" && bearer.startsWith("eyJ")) {
      const { data: u } = await admin.auth.getUser(bearer);
      const uid = u?.user?.id;
      if (!uid) return json({ ok: false, error: "Not authenticated." }, 401);
      const { data: gs } = await admin.from("agent_groups")
        .select("id,name,created_at").eq("owner_user", uid).order("created_at", { ascending: false });
      const dayAgo = new Date(Date.now() - 86400000).toISOString();
      const rooms: Array<Record<string, unknown>> = [];
      for (const g of gs ?? []) {
        const gid = String(g.id);
        const [mc, last, tc] = await Promise.all([
          admin.from("agent_group_members").select("id", { count: "exact", head: true }).eq("group_id", gid),
          admin.from("agent_group_messages").select("author_name,source,created_at").eq("group_id", gid).order("created_at", { ascending: false }).limit(1),
          admin.from("agent_group_messages").select("id", { count: "exact", head: true }).eq("group_id", gid).gte("created_at", dayAgo),
        ]);
        const lm = last.data?.[0];
        rooms.push({
          id: gid, name: g.name, members: mc.count ?? 0, msgs_24h: tc.count ?? 0,
          last_at: lm?.created_at ?? null, last_from: lm ? (lm.author_name ?? lm.source ?? "?") : null,
        });
      }
      return json({ ok: true, rooms });
    }

    // ---- Web owner path: authenticated by a Supabase JWT + group_id, scoped to groups you own ----
    if (bearer.startsWith("eyJ") && body.group_id) {
      const { data: u } = await admin.auth.getUser(bearer);
      const uid = u?.user?.id;
      if (!uid) return json({ ok: false, error: "Not authenticated." }, 401);
      const gid = String(body.group_id);
      const { data: g } = await admin.from("agent_groups").select("id,name,owner_user").eq("id", gid).maybeSingle();
      if (!g || g.owner_user !== uid) return json({ ok: false, error: "Not your group." }, 403);
      const group = String(g.name);

      if (action === "timeline" || action === "read") {
        const { data: rows } = await admin.from("agent_group_messages")
          .select("id, member_id, author_name, kind, title, body, created_at, source")
          .eq("group_id", gid).order("created_at", { ascending: true }).limit(300);
        return json({ ok: true, group, count: (rows ?? []).length, messages: await shape(admin, rows ?? [], "") });
      }
      if (action === "history") {
        const before = body.before ? new Date(String(body.before)).toISOString() : null;
        const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);
        let hq = admin.from("agent_group_messages")
          .select("id, member_id, author_name, kind, title, body, created_at, source")
          .eq("group_id", gid).order("created_at", { ascending: false }).limit(limit);
        if (before) hq = hq.lt("created_at", before);
        const { data: hrows } = await hq;
        const desc = hrows ?? [];
        const asc = [...desc].reverse();
        return json({ ok: true, group, count: asc.length, has_more: desc.length === limit, next_before: desc.length ? desc[desc.length - 1].created_at : null, messages: await shape(admin, asc, "") });
      }
      if (action === "note") {
        const text = String(body.text ?? body.content ?? "").trim();
        if (!text) return json({ ok: false, error: "Nothing to add." });
        if (text.length > 100000) return json({ ok: false, error: "Too long (max 100000)." });
        const { data: prof } = await admin.from("profiles").select("username").eq("id", uid).maybeSingle();
        const author = prof?.username ? `@${prof.username}` : "owner";
        const kind = body.kind === "context" ? "context" : "log";
        const { data: msg, error } = await admin.from("agent_group_messages")
          .insert({ group_id: gid, author_name: author, kind, title: body.title ? String(body.title).slice(0, 120) : null, body: text })
          .select("id,created_at").single();
        if (error) return json({ ok: false, error: error.message });
        return json({ ok: true, id: msg.id, created_at: msg.created_at });
      }
      if (action === "catchup" || action === "digest") {
        const isDigest = action === "digest";
        const w = isDigest ? windowSince(String(body.period ?? "week").toLowerCase()) : null;
        const system = isDigest ? digestSystem(w!.label) : CATCHUP_SYSTEM;
        const r = await synthOverGroup(admin, gid, group, system, w ? w.since : null);
        const field = isDigest ? "digest" : "brief";
        const period = w?.label;
        if (r.count === 0) return json({ ok: true, group, period, message_count: 0, [field]: "Nothing here yet." });
        if (r.keyless) return json({ ok: true, group, period, message_count: r.count, mode: "agent", instructions: r.instructions, timeline: r.timeline, note: "No server LLM key set — set LLM_API_KEY to render this on the web, or run the tool inside your AI." });
        if (!r.ok) return json({ ok: false, error: r.error });
        return json({ ok: true, group, period, message_count: r.count, mode: "server", [field]: r.text });
      }
      return json({ ok: false, error: "Unknown owner action." });
    }

    if (!bearer.startsWith("gm_"))
      return json({ ok: false, error: "No group. Join a group first with ping_join (or ping_create_group), then set the returned gm_ token as your bearer." }, 401);
    const me = await memberFromToken(admin, bearer);
    if (!me) return json({ ok: false, error: "Invalid or expired member token. Re-join with your group link." }, 401);
    const gid = String(me.group_id);
    const meId = String(me.id);

    if (action === "whoami") {
      return json({ ok: true, name: me.name, group: await groupName(admin, gid), group_id: gid, members: await memberCount(admin, gid) });
    }
    if (action === "members") {
      const { data: ms } = await admin
        .from("agent_group_members").select("name,joined_at").eq("group_id", gid).order("joined_at", { ascending: true });
      return json({ ok: true, group: await groupName(admin, gid), members: (ms ?? []).map((m) => ({ name: m.name, you: m.name === me.name })) });
    }
    // Invite control. Any member can shut the door or reopen it — these rooms are
    // peer groups with no admin role, and inventing one here would be a bigger
    // change than the feature. Revoking stops NEW joins; it does not void the
    // tokens of members already in the room.
    if (action === "invite") {
      const op = String(body.op ?? "status");
      const { data: g } = await admin.from("agent_groups")
        .select("name,invite_code,invite_expires_at,invite_revoked_at").eq("id", gid).maybeSingle();
      if (!g) return json({ ok: false, error: "Group not found." });
      const patch: Record<string, string | null> = {};
      if (op === "revoke") patch.invite_revoked_at = new Date().toISOString();
      else if (op === "restore") patch.invite_revoked_at = null;
      else if (op === "expiry") {
        const raw = body.days;
        const days = Number(raw);
        if (raw === null || raw === undefined || days === 0) patch.invite_expires_at = null;
        else if (!Number.isFinite(days) || days < 0 || days > 365)
          return json({ ok: false, error: "days must be a number from 0 to 365 (0 or omitted = never expires)." });
        else patch.invite_expires_at = new Date(Date.now() + days * 86400000).toISOString();
      } else if (op !== "status") {
        return json({ ok: false, error: "op must be one of: status, revoke, restore, expiry." });
      }
      if (Object.keys(patch).length) {
        const { error } = await admin.from("agent_groups").update(patch).eq("id", gid);
        if (error) return json({ ok: false, error: error.message });
        Object.assign(g, patch);
      }
      const closed = inviteClosed(g);
      return json({
        ok: true,
        group: g.name,
        invite_url: `${SITE}/g/${g.invite_code}`,
        status: closed ? (g.invite_revoked_at ? "revoked" : "expired") : "open",
        revoked_at: g.invite_revoked_at ?? null,
        expires_at: g.invite_expires_at ?? null,
        members: await memberCount(admin, gid),
        note: closed
          ? "Nobody new can join with this link. Members already in the room keep their tokens. Use op:'restore' to reopen it."
          : "Anyone with this link can join. Use op:'revoke' to shut it, or op:'expiry' with days to make it age out on its own.",
      });
    }
    if (action === "leave") {
      await admin.from("agent_group_members").delete().eq("id", meId);
      return json({ ok: true, left: true, note: "You've left the group and this token is now void. Your past messages stay in the room under your name; you keep nothing. Re-join with the invite link any time for a fresh start." });
    }
    if (action === "say" || action === "share" || action === "log") {
      if (await limited(admin, "post:" + meId, RL.post)) return rlError("messages");
      const isCtx = action === "share";
      const isLog = action === "log";
      const text = String((isCtx ? body.content : body.text) ?? body.content ?? body.text ?? "").trim();
      if (!text) return json({ ok: false, error: isCtx ? "Nothing to share." : isLog ? "Nothing to log — pass what you did as 'text'." : "Need 'text'." });
      const max = isCtx ? 100000 : 8000;
      if (text.length > max) return json({ ok: false, error: `Too long (max ${max}).` });
      const title = body.title ? String(body.title).slice(0, 120) : null;
      const kind = isCtx ? "context" : isLog ? "log" : "chat";
      const { data: msg, error } = await admin
        .from("agent_group_messages")
        .insert({ group_id: gid, member_id: meId, author_name: me.name, kind, title, body: text })
        .select("id,created_at").single();
      if (error) return json({ ok: false, error: error.message });
      const next_step = isLog ? "Logged. It'll surface in ping_digest and ping_catchup." : "Sent. Call ping_wait to await their reply.";
      return json({ ok: true, id: msg.id, created_at: msg.created_at, next_step });
    }
    if (action === "read") {
      if (await limited(admin, "read:" + meId, RL.read)) return rlError("reads");
      // A caller that supplies its own `since` (e.g. the background Stop-hook
      // watcher) manages its OWN cursor — it must not move the shared last_read
      // that interactive ping_read / ping_wait depend on, or those go blind.
      const clientCursor = body.since !== undefined && body.since !== null && String(body.since) !== "";
      const since = clientCursor ? new Date(String(body.since)).toISOString() : String(me.last_read);
      let q = admin
        .from("agent_group_messages").select("id, member_id, author_name, kind, title, body, created_at, source")
        .eq("group_id", gid).order("created_at", { ascending: true }).limit(200);
      if (since) q = q.gt("created_at", since);
      const { data: rows } = await q;
      const msgs = rows ?? [];
      if (!clientCursor) {
        const cursor = msgs.length ? msgs[msgs.length - 1].created_at : new Date().toISOString();
        await admin.from("agent_group_members").update({ last_read: cursor }).eq("id", meId);
      }
      return json({ ok: true, group: await groupName(admin, gid), count: msgs.length, messages: await shape(admin, msgs, meId) });
    }
    if (action === "history") {
      // Page BACKWARD through the timeline (older than `before`). Read-only —
      // never advances last_read. Returns oldest→newest with a next_before cursor.
      if (await limited(admin, "read:" + meId, RL.read)) return rlError("reads");
      const before = body.before ? new Date(String(body.before)).toISOString() : null;
      const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);
      let hq = admin
        .from("agent_group_messages").select("id, member_id, author_name, kind, title, body, created_at, source")
        .eq("group_id", gid).order("created_at", { ascending: false }).limit(limit);
      if (before) hq = hq.lt("created_at", before);
      const { data: hrows } = await hq;
      const desc = hrows ?? [];
      const asc = [...desc].reverse();
      return json({ ok: true, group: await groupName(admin, gid), count: asc.length, has_more: desc.length === limit, next_before: desc.length ? desc[desc.length - 1].created_at : null, messages: await shape(admin, asc, meId) });
    }
    if (action === "catchup") {
      const group = (await groupName(admin, gid)) ?? "this group";
      const r = await synthOverGroup(admin, gid, group, CATCHUP_SYSTEM, null);
      if (r.count === 0) return json({ ok: true, group, message_count: 0, brief: "This room is empty — no messages or shared context yet. Say hi with ping_say, or post what you're working on with ping_share." });
      if (r.keyless) return json({ ok: true, group, message_count: r.count, mode: "agent", instructions: r.instructions, timeline: r.timeline, note: "No server key is set (that's the default). YOU write the briefing: follow `instructions` to turn `timeline` into the briefing, then present it to the user." });
      if (!r.ok) return json({ ok: false, error: r.error });
      return json({ ok: true, group, message_count: r.count, mode: "server", brief: r.text });
    }
    if (action === "digest") {
      const group = (await groupName(admin, gid)) ?? "this group";
      const w = windowSince(String(body.period ?? "week").toLowerCase());
      const r = await synthOverGroup(admin, gid, group, digestSystem(w.label), w.since);
      if (r.count === 0) return json({ ok: true, group, period: w.label, message_count: 0, digest: `Nothing logged in the ${w.label}. Post work with ping_say / ping_share / ping_log, or wire your repo's webhook so commits and PRs land here automatically.` });
      if (r.keyless) return json({ ok: true, group, period: w.label, message_count: r.count, mode: "agent", instructions: r.instructions, timeline: r.timeline, note: "No server key is set (that's the default). YOU write the digest: follow `instructions` to turn `timeline` into the sectioned, ticket-ready digest, then present it to the user." });
      if (!r.ok) return json({ ok: false, error: r.error });
      return json({ ok: true, group, period: w.label, message_count: r.count, mode: "server", digest: r.text });
    }
    if (action === "wait") {
      if (await limited(admin, "wait:" + meId, RL.wait)) return rlError("waits");
      const since = String(me.last_read);
      const startedAt = Date.now();
      const maxMs = 8000;
      while (true) {
        const { data: rows } = await admin
          .from("agent_group_messages").select("id, member_id, author_name, kind, title, body, created_at, source")
          .eq("group_id", gid).gt("created_at", since).order("created_at", { ascending: true }).limit(50);
        const all = rows ?? [];
        const fresh = all.filter((m) => m.member_id !== meId);
        if (fresh.length) {
          await admin.from("agent_group_members").update({ last_read: all[all.length - 1].created_at }).eq("id", meId);
          return json({ ok: true, count: fresh.length, messages: await shape(admin, fresh, meId) });
        }
        if (Date.now() - startedAt >= maxMs)
          return json({ ok: true, count: 0, timed_out: true, note: "No reply yet — call ping_wait again to keep waiting." });
        await sleep(1200);
      }
    }

    return json({ ok: false, error: "Unknown action." });
  } catch (e) {
    return json({ ok: false, error: "Server error: " + String(e) });
  }
});
