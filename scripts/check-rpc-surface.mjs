#!/usr/bin/env node
// Which database functions can a stranger call?
//
// Postgres grants EXECUTE on a new function to PUBLIC by default, and PostgREST
// publishes everything in the `public` schema at /rest/v1/rpc/<name>. Those two
// defaults combine into HTTP endpoints nobody wrote and nobody reviews. That is
// how claim_agent_task — the atomic claim the task board rests on — ended up
// callable by anyone holding the anon key, which is public by design.
//
// So this walks every function the repo defines, calls it with the anon key,
// and fails if one answers that should not. A new function inherits the PUBLIC
// grant, so without this check the next one lands exposed and silent.
//
//   node scripts/check-rpc-surface.mjs
//   node scripts/check-rpc-surface.mjs --json
//
// It probes with null arguments and only probes functions that are expected to
// be CLOSED, so a passing run executes nothing. A failing run means something
// ran that should not have — which is the finding.

import { readFile } from "node:fs/promises";

const SCHEMA = new URL("../supabase/schema.sql", import.meta.url);
const BASE = process.env.PING_SUPABASE_URL ?? "https://wsdslkxdoqwspjfozwvl.supabase.co";
// The anon key is public on purpose: it ships in public/ping-notify.mjs and is
// served from theping.chat. That is exactly why this check exists.
const ANON = process.env.PING_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndzZHNsa3hkb3F3c3BqZm96d3ZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5ODg3NjQsImV4cCI6MjEwMDU2NDc2NH0.Kuop6VvV3Ykak8SqH8yBJbt0H6N-mB2-riSVFQS7aDo";
const JSON_OUT = process.argv.includes("--json");

// Functions a stranger is MEANT to be able to call. Everything else must deny.
// Adding a name here is a security decision: say why, so the next person can
// judge whether the reason still holds.
const ALLOWED = new Map([
  [
    "rl_hook",
    "Webhook rate limiter. Its argument is the secret webhook token, and anyone " +
      "holding that can already post into the room — strictly more than burning " +
      "its rate budget. The /hook route calls it with the anon key and fails open, " +
      "so revoking it would silently disable webhook rate limiting.",
  ],
]);

// Pull every function the repo defines, with its parameter names, out of the
// committed schema. The repo is the right source: it covers what we ship, not
// just what the server currently admits to.
async function declaredFunctions() {
  const sql = await readFile(SCHEMA, "utf8");
  const re = /CREATE OR REPLACE FUNCTION "public"\."([a-z0-9_]+)"\(([^)]*)\)/gi;
  const found = new Map();
  for (const m of sql.matchAll(re)) {
    const name = m[1];
    const params = [...m[2].matchAll(/"([a-z0-9_]+)"\s+"?[a-z0-9_ \[\]]+"?/gi)].map((p) => p[1]);
    // Keep the widest signature seen, so a call carries every parameter name.
    if (!found.has(name) || found.get(name).length < params.length) found.set(name, params);
  }
  return found;
}

async function probe(name, params) {
  const body = Object.fromEntries(params.map((p) => [p, null]));
  const res = await fetch(`${BASE}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let code = null;
  try { code = JSON.parse(text)?.code ?? null; } catch { /* not JSON */ }

  // 42501 is Postgres' permission denied — the call was refused before the
  // function ran. PGRST202 means PostgREST could not resolve it at all, which
  // for a function the repo defines means it is not in anon's surface.
  if (res.status === 401 || code === "42501") return { state: "denied", status: res.status };
  if (code === "PGRST202") return { state: "absent", status: res.status };
  return { state: "REACHABLE", status: res.status, body: text.slice(0, 160) };
}

const declared = await declaredFunctions();
const results = [];
for (const [name, params] of [...declared].sort()) {
  if (ALLOWED.has(name)) {
    results.push({ name, state: "allowed", why: ALLOWED.get(name) });
    continue;
  }
  try {
    results.push({ name, ...(await probe(name, params)) });
  } catch (e) {
    results.push({ name, state: "error", error: String(e.message ?? e) });
  }
}

const exposed = results.filter((r) => r.state === "REACHABLE");
const errored = results.filter((r) => r.state === "error");

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ ok: !exposed.length && !errored.length, checked: results.length, exposed, results }, null, 2) + "\n");
} else {
  process.stdout.write(`\nRPC surface — ${results.length} functions declared in schema.sql\n\n`);
  for (const r of exposed) {
    process.stdout.write(`  EXPOSED  ${r.name}  HTTP ${r.status}\n           ${r.body}\n`);
  }
  for (const r of errored) process.stdout.write(`  ERROR    ${r.name}  ${r.error}\n`);
  const denied = results.filter((r) => r.state === "denied").length;
  const absent = results.filter((r) => r.state === "absent").length;
  const allowed = results.filter((r) => r.state === "allowed").length;
  process.stdout.write(
    `\n  ${denied} denied · ${absent} not exposed · ${allowed} allowed by policy · ${exposed.length} EXPOSED\n`
  );
  if (exposed.length) {
    process.stdout.write(
      `\nA stranger can run the above with nothing but the public anon key.\n` +
        `Revoke it, or add it to ALLOWED in this file with the reason it is safe:\n\n` +
        `  revoke all on function public.<name>(<args>) from public, anon, authenticated;\n` +
        `  grant execute on function public.<name>(<args>) to service_role;\n\n`
    );
  } else {
    process.stdout.write("\nNothing reachable that should not be.\n\n");
  }
}
process.exit(exposed.length || errored.length ? 1 : 0);
