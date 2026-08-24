// Shared state handling for ~/.ping/state.json.
//
// Every Ping surface (the /ping command, the Stop hook) reads and writes this
// file, and several agent sessions can be running at once. The old code did a
// plain writeFileSync of a read-modify-write, so two sessions finishing at the
// same moment would clobber each other's cursors — or drop a room entirely.
// Writes here take a lock and land via rename(), which is atomic on POSIX, so a
// reader never sees a half-written file.
//
// Shape: { watch: bool, active: <group name>, rooms: [{token, group, name, last_seen}] }

import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DIR = join(homedir(), ".ping");
export const STATE = join(DIR, "state.json");
const LOCK = STATE + ".lock";

// Block without spinning the CPU. Node has no sleepSync; Atomics.wait on a
// throwaway buffer is the standard trick.
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best effort */ }
};

// Run fn() while holding an exclusive lock. A lock older than 10s is treated as
// stale (a crashed session) and broken, so a dead process can't wedge the file
// forever. If the lock never frees we still run — losing a cursor update is bad,
// but silently doing nothing is worse.
export function withLock(fn) {
  // The lockfile lives in DIR, so DIR must exist before we can lock at all.
  // Without this, a first run threw ENOENT and every concurrent writer fell
  // through to the unlocked path — exactly the clobbering this guards against.
  try { mkdirSync(DIR, { recursive: true }); } catch { /* fall through to unlocked */ }
  for (let i = 0; i < 40; i++) {
    try {
      closeSync(openSync(LOCK, "wx"));
      try { return fn(); } finally { try { unlinkSync(LOCK); } catch { /* already gone */ } }
    } catch (e) {
      if (e?.code !== "EEXIST") break; // can't lock at all (perms, missing dir) -> just run
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 10_000) { unlinkSync(LOCK); continue; }
      } catch { /* vanished between check and stat -> retry */ }
      sleepSync(25);
    }
  }
  return fn();
}

export function readState() {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; }
}

// Atomic: write a sibling temp file, fsync-free rename over the target.
export function writeStateRaw(state) {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${STATE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, STATE);
  try { chmodSync(STATE, 0o600); } catch { /* token file; best effort */ }
}

// Read-modify-write under one lock, so concurrent sessions serialize instead of
// overwriting each other.
export function updateState(mutate) {
  return withLock(() => {
    const next = mutate(readState()) ?? {};
    writeStateRaw(next);
    return next;
  });
}

// Normalize any stored shape into a rooms array. Keeps `name` — the legacy
// migration used to drop it, which permanently disabled @mention detection for
// anyone who had joined before multi-room landed.
export function roomsOf(state) {
  if (Array.isArray(state?.rooms)) return state.rooms.filter((r) => r && r.token);
  if (state?.token) return [{ token: state.token, group: state.group, name: state.name, last_seen: state.last_seen }];
  return [];
}

// Add or refresh a room. Dedupes on token AND on group name: re-running /ping
// with a fresh invite for a room you're already in used to append a second entry
// with a second membership, and every message then arrived twice.
export function upsertRoom(state, room) {
  const rooms = roomsOf(state).filter(
    (r) => r.token !== room.token && !(room.group && r.group === room.group)
  );
  rooms.push(room);
  return { ...state, watch: true, active: room.group ?? state.active, rooms };
}
