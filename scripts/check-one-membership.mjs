#!/usr/bin/env node
// One person, one membership per room.
//
// ping_members is how an agent decides who to hand work to. When the same
// person holds several memberships it cannot tell one person who joined three
// times from three people — a live two-person test ended with six rows, one of
// them a name the user no longer used whose read cursor sat at the epoch, so
// work routed there would have waited for ever.
//
// The rule has to hold on the server: a client speaking raw MCP (Codex, Cursor)
// never loads the plugin and cannot be asked to behave. These assertions guard
// the server's copy — including its position, because the guard was first
// written into create_group, where a brand-new room has no members and it can
// never fire.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../supabase/functions/group-api/index.ts", import.meta.url), "utf8");

const start = src.indexOf('if (action === "join")');
assert.ok(start > 0, "the join handler must exist");
// The handler runs until the next top-level action in the same chain.
const after = src.indexOf('if (action === ', start + 10);
const join = src.slice(start, after > 0 ? after : undefined);

const guard = join.indexOf("agent_group_members");
const insert = join.indexOf("newMemberToken()");
assert.ok(guard > 0, "join must look for an existing member with this name");
assert.ok(/\.eq\("name", name\)/.test(join), "it must look that member up BY NAME — that is what one-per-person means");
assert.ok(guard < insert, "the name check must come BEFORE a token is minted, or the duplicate already exists");
assert.match(join, /409/, "a name already taken is a conflict, and must be refused with 409");

// Refused, never deduped: handing back the existing token would give anyone
// holding the invite link another member's identity.
assert.doesNotMatch(join, /token: taken|return json\(\{ ok: true[^}]*taken/, "a taken name must never be answered with the existing token");

// maybeSingle() errors when several rows match, and several rows is exactly the
// state this guard exists to stop spreading — it would fail open on every room
// that is already broken.
assert.ok(!/\.eq\("name", name\)\.maybeSingle\(\)/.test(join), "look the name up with limit(1), not a bare maybeSingle()");

// The guard is a trap without a way out: a dead session holds its name for ever.
assert.match(src, /action === "remove_member"/, "an owner must be able to clear a stale membership");
assert.match(src, /\.neq\("id", meId\)/, "removing yourself is ping_leave's job, not remove_member's");

console.log("check-one-membership: all assertions passed");
