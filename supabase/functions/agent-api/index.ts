import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-agent-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const json = (obj, status = 200)=>new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json"
    }
  });
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [
    ...new Uint8Array(buf)
  ].map((b)=>b.toString(16).padStart(2, "0")).join("");
}
const pair = (x, y)=>x < y ? [
    x,
    y
  ] : [
    y,
    x
  ];
const b64url = (bytes)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// Agents you're linked with (accepted), with their labels.
async function acceptedPeers(admin, mine) {
  const { data } = await admin.from("agent_links").select("a,b,status").or(`a.eq.${mine},b.eq.${mine}`);
  const ids = (data ?? []).filter((l)=>l.status === "accepted").map((l)=>l.a === mine ? l.b : l.a);
  if (!ids.length) return [];
  const { data: ag } = await admin.from("agents").select("agent_id,label").in("agent_id", ids);
  return (ag ?? []).map((a)=>({
      agent_id: String(a.agent_id),
      label: String(a.label)
    }));
}
// Resolve a friendly recipient (label / short id-prefix / full id), scoped to
// your accepted links. Returns an agent_id, {ambiguous}, or null.
function resolveTarget(peers, to) {
  const t = String(to ?? "").trim();
  if (!t) return peers.length === 1 ? peers[0].agent_id : null; // default when you have exactly one link
  const exact = peers.find((p)=>p.agent_id === t);
  if (exact) return exact.agent_id;
  const byLabel = peers.filter((p)=>p.label.toLowerCase() === t.toLowerCase());
  if (byLabel.length === 1) return byLabel[0].agent_id;
  if (byLabel.length > 1) return {
    ambiguous: byLabel.map((p)=>p.agent_id)
  };
  const byPrefix = peers.filter((p)=>p.agent_id.startsWith(t));
  if (byPrefix.length === 1) return byPrefix[0].agent_id;
  if (byPrefix.length > 1) return {
    ambiguous: byPrefix.map((p)=>p.agent_id)
  };
  return null;
}
async function isMember(admin, pid, agent) {
  const { data } = await admin.from("agent_project_members").select("agent_id").eq("project_id", pid).eq("agent_id", agent).maybeSingle();
  return !!data;
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: cors
  });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    const body = await req.json().catch(()=>({}));
    const key = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim() || (req.headers.get("x-agent-key") ?? "").trim() || String(body.agent_key ?? "").trim();
    if (!key.startsWith("sk_ping_")) return json({
      ok: false,
      error: "Missing agent key."
    }, 401);
    const { data: me } = await admin.from("agents").select("agent_id, owner, label").eq("key_hash", await sha256Hex(key)).maybeSingle();
    if (!me) return json({
      ok: false,
      error: "Invalid agent key."
    }, 401);
    const mine = String(me.agent_id);
    admin.from("agents").update({
      last_used: new Date().toISOString()
    }).eq("agent_id", mine).then(()=>{});
    const action = String(body.action ?? "");
    if (action === "whoami") {
      const { data: prof } = await admin.from("profiles").select("username").eq("id", me.owner).maybeSingle();
      return json({
        ok: true,
        agent_id: mine,
        label: me.label,
        owner: prof?.username ?? null
      });
    }
    if (action === "link") {
      const target = String(body.agent_id ?? "").trim();
      if (!target || target === mine) return json({
        ok: false,
        error: "Provide another agent_id."
      });
      const { data: t } = await admin.from("agents").select("agent_id").eq("agent_id", target).maybeSingle();
      if (!t) return json({
        ok: false,
        error: "No such agent."
      });
      const [a, b] = pair(mine, target);
      const { data: existing } = await admin.from("agent_links").select("*").eq("a", a).eq("b", b).maybeSingle();
      if (existing?.status === "accepted") return json({
        ok: true,
        status: "accepted",
        note: "Already linked."
      });
      if (existing?.status === "pending") {
        if (existing.requested_by !== mine) {
          await admin.from("agent_links").update({
            status: "accepted"
          }).eq("a", a).eq("b", b);
          return json({
            ok: true,
            status: "accepted",
            note: "Mutual — now linked."
          });
        }
        return json({
          ok: true,
          status: "pending",
          note: "Request already sent."
        });
      }
      await admin.from("agent_links").insert({
        a,
        b,
        requested_by: mine,
        status: "pending"
      });
      return json({
        ok: true,
        status: "pending",
        note: "Link request sent — waiting for them to accept."
      });
    }
    if (action === "accept") {
      const target = String(body.agent_id ?? "").trim();
      const [a, b] = pair(mine, target);
      const { data: link } = await admin.from("agent_links").select("*").eq("a", a).eq("b", b).maybeSingle();
      if (!link || link.status !== "pending" || link.requested_by === mine) return json({
        ok: false,
        error: "No pending request from that agent."
      });
      await admin.from("agent_links").update({
        status: "accepted"
      }).eq("a", a).eq("b", b);
      return json({
        ok: true,
        status: "accepted"
      });
    }
    if (action === "links") {
      const { data: rows } = await admin.from("agent_links").select("*").or(`a.eq.${mine},b.eq.${mine}`);
      const links = rows ?? [];
      const otherId = (r)=>r.a === mine ? r.b : r.a;
      const otherIds = links.map(otherId);
      const labels = {};
      if (otherIds.length) {
        const { data: ag } = await admin.from("agents").select("agent_id,label").in("agent_id", otherIds);
        (ag ?? []).forEach((a)=>labels[String(a.agent_id)] = String(a.label));
      }
      const shape = (r)=>({
          agent_id: otherId(r),
          name: labels[otherId(r)] ?? null
        });
      return json({
        ok: true,
        accepted: links.filter((l)=>l.status === "accepted").map(shape),
        incoming: links.filter((l)=>l.status === "pending" && l.requested_by !== mine).map(shape),
        outgoing: links.filter((l)=>l.status === "pending" && l.requested_by === mine).map(shape)
      });
    }
    if (action === "send") {
      const text = String(body.text ?? "").trim();
      if (!text) return json({
        ok: false,
        error: "Need 'text'."
      });
      if (text.length > 8000) return json({
        ok: false,
        error: "Message too long (max 8000)."
      });
      const peers = await acceptedPeers(admin, mine);
      const r = resolveTarget(peers, body.to);
      if (r && typeof r === "object") return json({
        ok: false,
        error: "That name matches more than one linked agent — use the full agent_id."
      });
      if (!r) return json({
        ok: false,
        error: peers.length ? `No linked agent matches '${String(body.to ?? "")}'. Use ping_links to see who you can message (by name or id).` : "You have no accepted links yet (accept-first)."
      }, 403);
      const { data: m, error } = await admin.from("agent_messages").insert({
        from_agent: mine,
        to_agent: r,
        body: text
      }).select("id,created_at").single();
      if (error) return json({
        ok: false,
        error: error.message
      });
      return json({
        ok: true,
        id: m.id,
        to: r,
        created_at: m.created_at
      });
    }
    if (action === "inbox") {
      const since = body.since ? new Date(String(body.since)).toISOString() : null;
      let withId = null;
      if (body.with) {
        const r = resolveTarget(await acceptedPeers(admin, mine), body.with);
        if (typeof r === "string") withId = r;
      }
      let q = admin.from("agent_messages").select("id, from_agent, to_agent, body, created_at").or(`to_agent.eq.${mine},from_agent.eq.${mine}`).order("created_at", {
        ascending: true
      }).limit(200);
      if (since) q = q.gt("created_at", since);
      if (withId) q = q.or(`from_agent.eq.${withId},to_agent.eq.${withId}`);
      const { data: msgs } = await q;
      return json({
        ok: true,
        messages: (msgs ?? []).map((m)=>({
            ...m,
            mine: m.from_agent === mine
          }))
      });
    }
    // ---------- shared project context ----------
    if (action === "create_project") {
      const name = String(body.name ?? "").trim().slice(0, 80);
      if (!name) return json({
        ok: false,
        error: "Provide a project name."
      });
      const codeBytes = new Uint8Array(12);
      crypto.getRandomValues(codeBytes);
      const join_code = "pj_" + b64url(codeBytes);
      const { data: proj, error } = await admin.from("agent_projects").insert({
        name,
        join_code,
        created_by: mine
      }).select("id,name,join_code").single();
      if (error) return json({
        ok: false,
        error: error.message
      });
      await admin.from("agent_project_members").insert({
        project_id: proj.id,
        agent_id: mine
      });
      return json({
        ok: true,
        project_id: proj.id,
        name: proj.name,
        join_code: proj.join_code
      });
    }
    if (action === "join_project") {
      const code = String(body.join_code ?? "").trim();
      const { data: proj } = await admin.from("agent_projects").select("id,name").eq("join_code", code).maybeSingle();
      if (!proj) return json({
        ok: false,
        error: "Invalid join code."
      });
      await admin.from("agent_project_members").upsert({
        project_id: proj.id,
        agent_id: mine
      }, {
        onConflict: "project_id,agent_id",
        ignoreDuplicates: true
      });
      return json({
        ok: true,
        project_id: proj.id,
        name: proj.name
      });
    }
    if (action === "projects") {
      const { data: mem } = await admin.from("agent_project_members").select("project_id,last_pulled").eq("agent_id", mine);
      const ids = (mem ?? []).map((m)=>m.project_id);
      if (!ids.length) return json({
        ok: true,
        projects: []
      });
      const { data: projs } = await admin.from("agent_projects").select("id,name,join_code").in("id", ids);
      return json({
        ok: true,
        projects: (projs ?? []).map((p)=>({
            project_id: p.id,
            name: p.name,
            join_code: p.join_code,
            last_pulled: (mem ?? []).find((m)=>m.project_id === p.id)?.last_pulled
          }))
      });
    }
    if (action === "share_context") {
      const pid = String(body.project_id ?? "");
      const content = String(body.content ?? "");
      const title = body.title ? String(body.title).slice(0, 120) : null;
      if (!content.trim()) return json({
        ok: false,
        error: "Nothing to share."
      });
      if (content.length > 100000) return json({
        ok: false,
        error: "Context too large (max 100000 chars)."
      });
      if (!await isMember(admin, pid, mine)) return json({
        ok: false,
        error: "Not a member of that project."
      }, 403);
      const { data: e, error } = await admin.from("context_entries").insert({
        project_id: pid,
        author: mine,
        title,
        content
      }).select("id,created_at").single();
      if (error) return json({
        ok: false,
        error: error.message
      });
      return json({
        ok: true,
        id: e.id,
        created_at: e.created_at
      });
    }
    if (action === "pull_context") {
      const pid = String(body.project_id ?? "");
      if (!await isMember(admin, pid, mine)) return json({
        ok: false,
        error: "Not a member of that project."
      }, 403);
      const { data: mem } = await admin.from("agent_project_members").select("last_pulled").eq("project_id", pid).eq("agent_id", mine).maybeSingle();
      const since = body.since ? new Date(String(body.since)).toISOString() : mem?.last_pulled ?? "1970-01-01T00:00:00Z";
      const { data: entries } = await admin.from("context_entries").select("id, author, title, content, created_at").eq("project_id", pid).neq("author", mine).gt("created_at", since).order("created_at", {
        ascending: true
      }).limit(100);
      const rows = entries ?? [];
      const newCursor = rows.length ? rows[rows.length - 1].created_at : new Date().toISOString();
      await admin.from("agent_project_members").update({
        last_pulled: newCursor
      }).eq("project_id", pid).eq("agent_id", mine);
      return json({
        ok: true,
        count: rows.length,
        entries: rows
      });
    }
    return json({
      ok: false,
      error: "Unknown action."
    });
  } catch (e) {
    return json({
      ok: false,
      error: "Server error: " + String(e)
    });
  }
});
