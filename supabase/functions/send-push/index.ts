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
// The Android app gets its notifications through Firebase Cloud Messaging (HTTP
// v1). FCM_SERVICE_ACCOUNT holds the service account JSON, base64-encoded; it
// signs a short-lived OAuth token, cached for the life of this instance.
// ponytail: plain fetch + Web Crypto instead of firebase-admin, which doesn't
// run on Deno edge functions without shims.
const FCM_SA = (()=>{
  try {
    return JSON.parse(atob(Deno.env.get("FCM_SERVICE_ACCOUNT") ?? ""));
  } catch  {
    return null;
  }
})();
let fcmAuth = null;
const b64url = (data)=>btoa(typeof data === "string" ? data : String.fromCharCode(...new Uint8Array(data))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
async function fcmBearer() {
  if (!FCM_SA) return null;
  const now = Math.floor(Date.now() / 1000);
  if (fcmAuth && fcmAuth.exp - 60 > now) return fcmAuth.token;
  const der = Uint8Array.from(atob(FCM_SA.private_key.replace(/-----[^-]+-----|\s/g, "")), (c)=>c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256"
  }, false, [
    "sign"
  ]);
  const unsigned = b64url(JSON.stringify({
    alg: "RS256",
    typ: "JWT"
  })) + "." + b64url(JSON.stringify({
    iss: FCM_SA.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: unsigned + "." + b64url(sig)
    })
  });
  if (!res.ok) return null;
  const j = await res.json();
  fcmAuth = {
    token: j.access_token,
    exp: now + (j.expires_in ?? 3600)
  };
  return fcmAuth.token;
}
// Same notification to every app install of these people. A token FCM says is
// unregistered (app removed, data cleared) is dropped.
async function fanOutNative(admin, userIds, n) {
  const { data: rows } = await admin.from("device_tokens").select("token").in("user_id", userIds);
  if (!rows?.length) return 0;
  const bearer = await fcmBearer();
  if (!bearer) return 0;
  let sent = 0;
  await Promise.all(rows.map(async ({ token })=>{
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${FCM_SA.project_id}/messages:send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: {
          token,
          notification: {
            title: n.title,
            body: n.body
          },
          data: {
            url: n.url
          },
          android: {
            priority: "HIGH",
            notification: {
              channel_id: "messages",
              ...n.tag ? {
                tag: n.tag
              } : {}
            }
          }
        }
      })
    }).catch(()=>null);
    if (res?.ok) sent++;
    else if (res?.status === 404) await admin.from("device_tokens").delete().eq("token", token);
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
    const note = {
      title: g.name ? String(g.name) : "Agent room",
      body: line.slice(0, 120),
      url: "/fleet",
      // One room collapses into one notification instead of stacking.
      tag: `room-${room}`
    };
    const [web, apps] = await Promise.all([
      fanOut(admin, subs, JSON.stringify(note)),
      fanOutNative(admin, ids, note)
    ]);
    return ok(web + apps);
  }
  if (!recipient) return ok(0);
  const { data: sp } = await admin.from("profiles").select("username").eq("id", sender).maybeSingle();
  const from = sp?.username ? String(sp.username) : "someone";
  const { data: subs } = await admin.from("push_subscriptions").select("*").eq("user_id", recipient);
  // Encrypted messages arrive with an empty body (server can't read them).
  const note = {
    title: `New message from @${from}`,
    body: String(body ?? "").slice(0, 120) || "🔒 Tap to read",
    url: `/app/dm/${from}`
  };
  const [web, apps] = await Promise.all([
    fanOut(admin, subs, JSON.stringify(note)),
    fanOutNative(admin, [
      recipient
    ], note)
  ]);
  return ok(web + apps);
});
