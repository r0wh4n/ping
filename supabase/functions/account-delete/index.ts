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
// Permanently deletes the calling user's account. Deleting the auth user
// cascades to public.profiles (profiles_id_fkey ON DELETE CASCADE) and from
// there to friendships, messages, push_subscriptions, thread_settings.
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: cors
  });
  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt) return json({
      ok: false,
      error: "Not signed in."
    }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    // Validate the token and resolve who is calling.
    const { data: { user }, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !user) return json({
      ok: false,
      error: "Not signed in."
    }, 401);
    const { error: dErr } = await admin.auth.admin.deleteUser(user.id);
    if (dErr) return json({
      ok: false,
      error: dErr.message
    });
    return json({
      ok: true
    });
  } catch (e) {
    return json({
      ok: false,
      error: "Server error: " + String(e)
    });
  }
});
