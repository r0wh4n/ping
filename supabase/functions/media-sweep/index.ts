import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Deletes the dm-media files of messages that no longer exist. The
// media_goes_with_its_message migration queues a message's photo, video or
// voice note when the message is deleted; cron calls this through
// public.call_media_sweep() with the internal secret send-push already checks,
// so nothing else can trigger it.
const BATCH = 100;
const ROUNDS = 10; // up to 1,000 files a minute, enough for any backlog

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: secrets, error: sErr } = await admin.rpc("push_secrets");
  if (sErr || !secrets?.webhook) return new Response("misconfigured", { status: 500 });
  if (req.headers.get("x-webhook-secret") !== secrets.webhook) return new Response("unauthorized", { status: 401 });

  let removed = 0;
  for (let round = 0; round < ROUNDS; round++) {
    // The batch already leaves out any path a surviving message still uses.
    const { data: paths, error } = await admin.rpc("media_trash_batch", { n: BATCH });
    if (error) return Response.json({ ok: false, removed, error: error.message }, { status: 500 });
    if (!paths?.length) break;
    const { error: rmErr } = await admin.storage.from("dm-media").remove(paths);
    if (rmErr) return Response.json({ ok: false, removed, error: rmErr.message }, { status: 500 });
    // A path whose file is already gone counts as done too.
    await admin.from("media_trash").delete().in("path", paths);
    removed += paths.length;
  }
  return Response.json({ ok: true, removed });
});
