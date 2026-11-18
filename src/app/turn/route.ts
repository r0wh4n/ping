// Short-lived TURN credentials, minted per call by Cloudflare Realtime.
//
// Relay credentials shipped in the client bundle would be an open relay —
// anyone loading the page could pull your bandwidth. Cloudflare issues
// credentials that expire, so the long-lived TURN key stays on the server and
// the browser only ever sees something that dies on its own.
//
// This replaced a coturn `use-auth-secret` implementation that computed the
// HMAC here. Cloudflare does not accept that scheme: credentials come from its
// API instead, which also means the response is already in the exact shape
// RTCPeerConnection wants and nothing has to be assembled by hand.
//
// Needs TURN_KEY_ID and TURN_KEY_API_TOKEN (Dashboard → Realtime → TURN Keys).
// Without them this returns an empty list and every call runs on STUN alone —
// which works until both ends are behind NATs that need a relay, and then
// fails with the connection stuck in "connecting". The client says so.
import { createClient } from "@supabase/supabase-js";

const TTL_SECONDS = 6 * 60 * 60;

export async function GET(req: Request) {
  const keyId = process.env.TURN_KEY_ID;
  const apiToken = process.env.TURN_KEY_API_TOKEN;
  // Not configured: the client falls back to STUN on its own and reports
  // `relay: false` in its call trace, which is how this was finally spotted.
  if (!keyId || !apiToken) return Response.json({ iceServers: [] });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!url || !anon || !token) return new Response("unauthorized", { status: 401 });

  // Relay time costs money, so only a signed-in account can mint credentials.
  const sb = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) return new Response("unauthorized", { status: 401 });

  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      // customIdentifier ties relay usage to an account, so abuse can be traced
      // to whoever caused it instead of just showing up on the bill.
      body: JSON.stringify({ ttl: TTL_SECONDS, customIdentifier: data.user.id }),
      signal: AbortSignal.timeout(8000),
    }
  ).catch(() => null);

  // A relay we cannot reach must not take the call down with it: STUN still
  // connects most networks, so fall back to it rather than failing the call.
  if (!res?.ok) return Response.json({ iceServers: [] }, { headers: { "cache-control": "no-store" } });

  const body = (await res.json().catch(() => null)) as { iceServers?: unknown } | null;
  const servers = Array.isArray(body?.iceServers) ? body.iceServers : [];
  // Port 53 is blocked by browsers and only ever contributes a timeout.
  const usable = servers.map((s) => {
    const entry = s as { urls?: string | string[] };
    if (!Array.isArray(entry.urls)) return entry;
    return { ...entry, urls: entry.urls.filter((u) => !u.includes(":53?") && !u.endsWith(":53")) };
  });

  return Response.json({ iceServers: usable, ttl: TTL_SECONDS }, { headers: { "cache-control": "no-store" } });
}
