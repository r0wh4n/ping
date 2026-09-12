// Short-lived TURN credentials.
//
// A relay username/password shipped in the client bundle is an open relay —
// anyone who loads the page can pull your bandwidth. coturn's `use-auth-secret`
// mode instead accepts a username of "<expiry>:<id>" with an HMAC of it as the
// password, so credentials are minted per call, expire on their own, and the
// shared secret never leaves the server.
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";

const TTL_SECONDS = 6 * 60 * 60;

export async function GET(req: Request) {
  const secret = process.env.TURN_SECRET;
  const urls = (process.env.TURN_URL ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  // Not configured: the client falls back to STUN and says so.
  if (!secret || !urls.length) return Response.json({ iceServers: [] });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!url || !anon || !token) return new Response("unauthorized", { status: 401 });

  // Relay time costs money, so only a signed-in account can mint credentials.
  const sb = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) return new Response("unauthorized", { status: 401 });

  const username = `${Math.floor(Date.now() / 1000) + TTL_SECONDS}:${data.user.id}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");

  return Response.json(
    { iceServers: [{ urls, username, credential }], ttl: TTL_SECONDS },
    { headers: { "cache-control": "no-store" } }
  );
}
