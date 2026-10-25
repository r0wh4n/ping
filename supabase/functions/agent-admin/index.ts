import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
const json = (obj, status = 200)=>new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json"
    }
  });
// Handle-authenticated admin surface for the website /agents dashboard. Serves
// the parts that live in service-role-only tables (links, projects), scoped to
// agents the signed-in handle owns.
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: cors
  });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return json({
      ok: false,
      error: "Sign in."
    }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    const { data: { user }, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !user) return json({
      ok: false,
      error: "Sign in."
    }, 401);
    const { data: agentRows } = await admin.from("agents").select("agent_id").eq("owner", user.id);
    const myIds = new Set((agentRows ?? []).map((a)=>String(a.agent_id)));
    if (myIds.size === 0) return json({
      ok: true,
      links: {
        incoming: [],
        outgoing: [],
        accepted: []
      },
      projects: []
    });
    const ids = [
      ...myIds
    ];
    const body = await req.json().catch(()=>({}));
    const action = String(body.action ?? "dashboard");
    if (action === "dashboard") {
      // links involving any of my agents
      const { data: la } = await admin.from("agent_links").select("*").in("a", ids);
      const { data: lb } = await admin.from("agent_links").select("*").in("b", ids);
      const seen = new Set();
      const rows = [
        ...la ?? [],
        ...lb ?? []
      ].filter((r)=>{
        const k = `${r.a}|${r.b}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const incoming = [], outgoing = [], accepted = [];
      for (const r of rows){
        const mySide = myIds.has(r.a) ? r.a : r.b;
        const other = mySide === r.a ? r.b : r.a;
        const item = {
          other,
          my_agent: mySide,
          a: r.a,
          b: r.b
        };
        if (r.status === "accepted") accepted.push(item);
        else if (r.requested_by === mySide) outgoing.push(item);
        else incoming.push(item);
      }
      const { data: mem } = await admin.from("agent_project_members").select("project_id").in("agent_id", ids);
      const pids = [
        ...new Set((mem ?? []).map((m)=>m.project_id))
      ];
      let projects = [];
      if (pids.length) {
        const { data: pr } = await admin.from("agent_projects").select("id,name,join_code").in("id", pids);
        projects = pr ?? [];
      }
      return json({
        ok: true,
        links: {
          incoming,
          outgoing,
          accepted
        },
        projects
      });
    }
    if (action === "accept_link" || action === "ignore_link") {
      const a = String(body.a ?? ""), b = String(body.b ?? "");
      const { data: row } = await admin.from("agent_links").select("*").eq("a", a).eq("b", b).maybeSingle();
      if (!row) return json({
        ok: false,
        error: "No such link."
      });
      const mySide = myIds.has(row.a) ? row.a : myIds.has(row.b) ? row.b : null;
      // Only the recipient (a side I own that did NOT request) can accept/ignore.
      if (!mySide || row.status !== "pending" || row.requested_by === mySide) return json({
        ok: false,
        error: "Not a pending request you can act on."
      }, 403);
      if (action === "accept_link") await admin.from("agent_links").update({
        status: "accepted"
      }).eq("a", a).eq("b", b);
      else await admin.from("agent_links").delete().eq("a", a).eq("b", b);
      return json({
        ok: true
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
