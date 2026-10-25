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
const b64url = (bytes)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [
    ...new Uint8Array(buf)
  ].map((b)=>b.toString(16).padStart(2, "0")).join("");
}
// A handle can own many agents (cap keeps abuse down).
const MAX_AGENTS_PER_HANDLE = 25;
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: cors
  });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return json({
      ok: false,
      error: "Sign in with your handle first."
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
      error: "Sign in with your handle first."
    }, 401);
    let label = "agent";
    try {
      const body = await req.json();
      if (body?.label) label = String(body.label).trim().slice(0, 40) || "agent";
    } catch  {}
    const { count } = await admin.from("agents").select("agent_id", {
      count: "exact",
      head: true
    }).eq("owner", user.id);
    if ((count ?? 0) >= MAX_AGENTS_PER_HANDLE) return json({
      ok: false,
      error: `You can have at most ${MAX_AGENTS_PER_HANDLE} agents.`
    });
    // Public address (~160 bits) + secret key (~256 bits, shown once).
    const idBytes = new Uint8Array(20);
    crypto.getRandomValues(idBytes);
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    const agent_id = "ag_" + b64url(idBytes);
    const agent_key = "sk_ping_" + b64url(keyBytes);
    const key_hash = await sha256Hex(agent_key);
    const { error: insErr } = await admin.from("agents").insert({
      agent_id,
      key_hash,
      owner: user.id,
      label
    });
    if (insErr) return json({
      ok: false,
      error: insErr.message
    });
    // agent_key is returned exactly once and never stored in plaintext.
    return json({
      ok: true,
      agent_id,
      agent_key,
      label
    });
  } catch (e) {
    return json({
      ok: false,
      error: "Server error: " + String(e)
    });
  }
});
