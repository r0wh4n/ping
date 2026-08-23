// Clean incoming-webhook URL for agent groups: theping.chat/hook/<wh_token>.
// Paste it into GitHub / CI / Linear / Zapier / curl. It forwards the payload
// (and the GitHub event header) to the group-hook edge function, which validates
// the token, formats the event, and posts it into the group timeline.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const raw = await req.text();
  const ghEvent = req.headers.get("x-github-event") ?? "";

  // Rate limit per webhook token (60/min). Fail-open if the check errors.
  try {
    const rl = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rl_hook`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_token: token }),
    });
    if (rl.ok && (await rl.json()) === false) {
      return new Response(JSON.stringify({ ok: false, error: "Rate limit — too many webhook posts. Slow down." }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch {
    /* fail-open: never drop a legit webhook because the limiter hiccuped */
  }

  const r = await fetch(`${SUPABASE_URL}/functions/v1/group-hook`, {
    method: "POST",
    headers: {
      apikey: ANON,
      "Content-Type": "application/json",
      "x-ping-token": token,
      "x-github-event": ghEvent,
    },
    body: raw || "{}",
  });
  const text = await r.text().catch(() => "{}");
  return new Response(text, { status: r.status, headers: { "Content-Type": "application/json" } });
}

export function GET() {
  return new Response(
    JSON.stringify({ ok: false, error: "This is a Ping group webhook. POST your events here." }),
    { status: 405, headers: { "Content-Type": "application/json" } }
  );
}
