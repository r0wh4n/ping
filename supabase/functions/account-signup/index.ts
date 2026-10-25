import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import nacl from "npm:tweetnacl@1.0.3";
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
const emailFor = (u)=>`${u.replace(/_/g, "-")}@theping.chat`;
const SIGNUPS_PER_IP_PER_HOUR = 10;
// ── invisible proof-of-work gate (mirrors src/lib/pow.ts) ──
const POW_ZEROS = 4;
const POW_BUCKET_SEC = 300;
function powOk(username, bucket, nonce) {
  if (!Number.isInteger(bucket) || !Number.isInteger(nonce) || nonce < 0) return false;
  const now = Math.floor(Date.now() / 1000 / POW_BUCKET_SEC);
  if (bucket > now + 1 || bucket < now - 2) return false; // must be fresh (~15 min window)
  const h = nacl.hash(new TextEncoder().encode(`${username}:${bucket}:${nonce}`));
  let hex = "";
  for(let i = 0; i < Math.ceil(POW_ZEROS / 2); i++)hex += h[i].toString(16).padStart(2, "0");
  return hex.slice(0, POW_ZEROS) === "0".repeat(POW_ZEROS);
}
// Free leaked-password protection via HaveIBeenPwned range API (k-anonymity).
async function isPwned(password) {
  try {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
    const hash = [
      ...new Uint8Array(buf)
    ].map((b)=>b.toString(16).padStart(2, "0")).join("").toUpperCase();
    const res = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
      headers: {
        "Add-Padding": "true"
      }
    });
    if (!res.ok) return false;
    const text = await res.text();
    return text.split("\n").some((line)=>line.split(":")[0].trim().toUpperCase() === hash.slice(5));
  } catch  {
    return false;
  }
}
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: cors
  });
  try {
    const { username, password, powBucket, powNonce } = await req.json();
    const uname = String(username ?? "").trim().toLowerCase();
    const pw = String(password ?? "");
    if (!/^[a-z0-9_]{3,20}$/.test(uname)) return json({
      ok: false,
      error: "Handle must be 3–20 chars: letters, numbers, underscores."
    });
    if (pw.length < 8) return json({
      ok: false,
      error: "Password must be at least 8 characters."
    });
    if (!powOk(uname, Number(powBucket), Number(powNonce))) return json({
      ok: false,
      error: "Couldn't verify your browser. Please refresh and try again."
    });
    if (await isPwned(pw)) return json({
      ok: false,
      error: "That password showed up in a known data breach. Please pick a different one."
    });
    const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    const sinceIso = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from("signup_attempts").select("ip", {
      count: "exact",
      head: true
    }).eq("ip", ip).gt("at", sinceIso);
    if ((count ?? 0) >= SIGNUPS_PER_IP_PER_HOUR) return json({
      ok: false,
      error: "Too many sign-ups from here. Try again later."
    }, 429);
    await admin.from("signup_attempts").insert({
      ip
    });
    const { data: taken } = await admin.from("profiles").select("id").eq("username", uname).maybeSingle();
    if (taken) return json({
      ok: false,
      error: "That handle is taken — try logging in."
    });
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: emailFor(uname),
      password: pw,
      email_confirm: true,
      user_metadata: {
        username: uname
      }
    });
    if (cErr || !created?.user) {
      if (/registered|already|exists/i.test(cErr?.message ?? "")) return json({
        ok: false,
        error: "That handle is taken — try logging in."
      });
      return json({
        ok: false,
        error: cErr?.message ?? "Could not create account."
      });
    }
    const { error: pErr } = await admin.from("profiles").insert({
      id: created.user.id,
      username: uname
    });
    if (pErr) {
      await admin.auth.admin.deleteUser(created.user.id);
      return json({
        ok: false,
        error: pErr.code === "23505" ? "That handle is taken." : pErr.message
      });
    }
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
