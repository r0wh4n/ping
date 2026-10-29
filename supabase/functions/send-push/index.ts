import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
// Public VAPID key is safe to keep in source (it ships to browsers as
// NEXT_PUBLIC_VAPID_PUBLIC_KEY). The private key + webhook secret live in Vault.
const VAPID_PUBLIC = "BOVRSY67Tf6YxXYgKnvhpI34ntfjO-jaLRe0SeCZ2fuRsLnMNZv1B3bGqlbS0EnRhI9t73Piae-toGToZATdnv0";
const ok = (sent)=>new Response(JSON.stringify({
    ok: true,
    sent
  }), {
    headers: {
      "Content-Type": "application/json"
    }
  });
// Deliver one notification to a set of subscriptions, dropping the ones the
// push service says are gone. Both the DM path and the room path end here.
async function fanOut(admin, subs, note) {
  let sent = 0;
  await Promise.all((subs ?? []).map(async (s)=>{
    try {
      await webpush.sendNotification({
        endpoint: s.endpoint,
        keys: {
          p256dh: s.p256dh,
          auth: s.auth
        }
      }, note);
      sent++;
    } catch (e) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) {
        await admin.from("push_subscriptions").delete().eq("id", s.id);
      }
    }
  }));
  return sent;
}
Deno.serve(async (req)=>{
  if (req.method !== "POST") return new Response("method", {
    status: 405
  });
  const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
  // Pull the webhook secret + VAPID private key from Vault (service-role RPC).
  const { data: secrets, error: sErr } = await admin.rpc("push_secrets");
  if (sErr || !secrets?.webhook || !secrets?.vapid_private) return new Response("misconfigured", {
    status: 500
  });
  if (req.headers.get("x-webhook-secret") !== secrets.webhook) return new Response("unauthorized", {
    status: 401
  });
  webpush.setVapidDetails("mailto:hello@theping.chat", VAPID_PUBLIC, secrets.vapid_private);
  let payload;
  try {
    payload = await req.json();
  } catch  {
    return new Response(JSON.stringify({
      ok: false
    }), {
      status: 200
    });
  }
  const { recipient, sender, body, room, author, title } = payload;
  // Agent room: the room has no account, so notify the humans attached to it —
  // the owner plus anyone who added it to Mission Control.
  if (room) {
    const { data: g } = await admin.from("agent_groups").select("name,owner_user").eq("id", room).maybeSingle();
    if (!g) return ok(0);
    const { data: vs } = await admin.from("agent_group_viewers").select("user_id").eq("group_id", room);
    const ids = [
      ...new Set([
        g.owner_user,
        ...(vs ?? []).map((v)=>v.user_id)
      ].filter(Boolean))
    ];
    if (!ids.length) return ok(0);
    const { data: subs } = await admin.from("push_subscriptions").select("*").in("user_id", ids);
    const line = `${author ?? "an agent"}: ${title ? title + " — " : ""}${String(body ?? "")}`;
    const note = JSON.stringify({
      title: g.name ? String(g.name) : "Agent room",
      body: line.slice(0, 120),
      url: "/fleet",
      // One room collapses into one notification instead of stacking.
      tag: `room-${room}`
    });
    return ok(await fanOut(admin, subs, note));
  }
  if (!recipient) return ok(0);
  const { data: sp } = await admin.from("profiles").select("username").eq("id", sender).maybeSingle();
  const from = sp?.username ? String(sp.username) : "someone";
  const { data: subs } = await admin.from("push_subscriptions").select("*").eq("user_id", recipient);
  // Encrypted messages arrive with an empty body (server can't read them).
  const note = JSON.stringify({
    title: `New message from @${from}`,
    body: String(body ?? "").slice(0, 120) || "🔒 Tap to read",
    url: `/app/dm/${from}`
  });
  return ok(await fanOut(admin, subs, note));
});
