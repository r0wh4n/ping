import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
// Public VAPID key is safe to keep in source (it ships to browsers as
// NEXT_PUBLIC_VAPID_PUBLIC_KEY). The private key + webhook secret live in Vault.
const VAPID_PUBLIC = "BOVRSY67Tf6YxXYgKnvhpI34ntfjO-jaLRe0SeCZ2fuRsLnMNZv1B3bGqlbS0EnRhI9t73Piae-toGToZATdnv0";
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
  const { recipient, sender, body } = payload;
  if (!recipient) return new Response(JSON.stringify({
    ok: true,
    sent: 0
  }), {
    status: 200
  });
  const { data: sp } = await admin.from("profiles").select("username").eq("id", sender).maybeSingle();
  const from = sp?.username ? String(sp.username) : "someone";
  const { data: subs } = await admin.from("push_subscriptions").select("*").eq("user_id", recipient);
  // Encrypted messages arrive with an empty body (server can't read them).
  const note = JSON.stringify({
    title: `New message from @${from}`,
    body: String(body ?? "").slice(0, 120) || "🔒 Tap to read",
    url: `/app/dm/${from}`
  });
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
  return new Response(JSON.stringify({
    ok: true,
    sent
  }), {
    headers: {
      "Content-Type": "application/json"
    }
  });
});
