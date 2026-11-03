// The role list exists twice and must stay identical.
// Run: node scripts/check-roles-match.mjs
//
// group-api decides which roles are real; the MCP route advertises them. Its
// schemas are additionalProperties:false, so a strict client silently DROPS any
// argument the route does not declare — add a role to the server alone and
// agents simply cannot send it, with no error anywhere to say why.
//
// ponytail: two copies and a check, not a shared module. One import would have
// to satisfy both the Next bundler and the Deno one that builds the edge
// function, and a broken bundle is a worse failure than a stale list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const listIn = (file, label) => {
  const src = readFileSync(new URL(file, import.meta.url), "utf8");
  const m = src.match(/const ROLES = \[([\s\S]*?)\] as const;/);
  assert.ok(m, `no ROLES array found in ${label} — did it get renamed?`);
  return [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
};

const server = listIn("../supabase/functions/group-api/index.ts", "group-api");
const mcp = listIn("../src/app/mcp/route.ts", "the MCP route");

assert.ok(server.length >= 2, "the server's role list looks empty — the regex probably stopped matching");
assert.deepEqual(
  mcp,
  server,
  "the MCP route's role list drifted from group-api's; a role only the server knows cannot be sent by any agent"
);

console.log(`roles: ${server.length} in sync between group-api and the MCP route`);
