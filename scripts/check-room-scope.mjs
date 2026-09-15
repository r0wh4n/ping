// Self-check for directory-scoped rooms.
// Run: node scripts/check-room-scope.mjs
//
// The failure this guards against is a quiet one: a room leaking into a project
// it does not belong to hands another client's write token to your agent.
import assert from "node:assert/strict";
import { roomMatchesCwd } from "../plugin/hooks/ping-state.mjs";

const room = (path) => ({ token: "gm_x", group: "g", path });

// 1. Rooms joined before scoping existed have no path and must keep working
//    everywhere — otherwise an upgrade silently stops delivering messages.
assert.equal(roomMatchesCwd({ token: "gm_x" }, "/anywhere"), true, "a pathless room stopped delivering");
assert.equal(roomMatchesCwd(room("/work/atom"), null), true, "unknown cwd hid a room");

// 2. The directory itself, and anything under it.
assert.equal(roomMatchesCwd(room("/work/atom"), "/work/atom"), true);
assert.equal(roomMatchesCwd(room("/work/atom"), "/work/atom/frontend"), true, "a subdirectory of the project lost its room");
assert.equal(roomMatchesCwd(room("/work/atom/"), "/work/atom"), true, "trailing separator broke the match");

// 3. The prefix trap. A plain startsWith would leak atom's room — and its token
//    — into a different repo that merely shares the first few characters.
assert.equal(roomMatchesCwd(room("/work/atom"), "/work/atom-legacy"), false, "a sibling directory matched on a bare prefix");
assert.equal(roomMatchesCwd(room("/work/atom"), "/work/atomic"), false, "a sibling directory matched on a bare prefix");

// 4. A parent directory is not inside the project.
assert.equal(roomMatchesCwd(room("/work/atom"), "/work"), false, "the parent directory matched");
assert.equal(roomMatchesCwd(room("/work/atom"), "/elsewhere"), false, "an unrelated directory matched");

// 5. The whole point: three clients on one machine stay separated.
const rooms = [room("/work/atom"), room("/work/bluewave"), room("/work/meter")];
const live = (cwd) => rooms.filter((r) => roomMatchesCwd(r, cwd)).map((r) => r.path);
assert.deepEqual(live("/work/meter"), ["/work/meter"], "another client's room surfaced during security work");
assert.deepEqual(live("/work/atom/src/components"), ["/work/atom"], "deep in one project, the wrong rooms appeared");
assert.deepEqual(live("/tmp/scratch"), [], "rooms surfaced in a directory none of them belong to");

console.log("room scope: 5/5 checks passed");
