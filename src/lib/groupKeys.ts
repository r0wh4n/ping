"use client";

// Group E2E key handling: one symmetric key per group per epoch, each sealed to
// a member's box public key. See supabase/group-e2e.sql for tables and policies.
import { supabase } from "@/lib/supabase";
import { getIdentity, newGroupKey, sealGroupKeyFor, openGroupKey, toB64 } from "@/lib/crypto";

type KeyRow = { user_id: string; sealed: string; sender_pub: string; epoch: number };

/** Every epoch key I can open, and the one new messages should use. */
export type GroupKeys = { keys: Map<number, Uint8Array>; current: number | null };

const NONE: GroupKeys = { keys: new Map(), current: null };

// The community room every account is dropped into by join_ping_hq(). People
// join it server-side with no member present to seal them a key, so it stays a
// plaintext room by design — keying it would lock out every future joiner.
export const PING_HQ = "0e1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b";

const rowsFor = async (groupId: string): Promise<KeyRow[]> => {
  const { data } = await supabase
    .from("group_keys")
    .select("user_id,sealed,sender_pub,epoch")
    .eq("group_id", groupId);
  return (data ?? []) as KeyRow[];
};

const pubKeys = async (ids: string[]): Promise<Map<string, string>> => {
  if (!ids.length) return new Map();
  const { data } = await supabase.from("profiles").select("id,public_key").in("id", ids);
  const m = new Map<string, string>();
  (data ?? []).forEach((p) => {
    if (p.public_key) m.set(String(p.id), String(p.public_key));
  });
  return m;
};

/** Seal `key` at `epoch` to each of `ids` that has a public key. Returns how many landed. */
async function sealTo(groupId: string, key: Uint8Array, epoch: number, ids: string[], mySecret: Uint8Array, myPub: string) {
  const pubs = await pubKeys(ids);
  const rows = ids
    .filter((id) => pubs.has(id))
    .map((id) => ({
      group_id: groupId,
      user_id: id,
      epoch,
      sealed: sealGroupKeyFor(key, pubs.get(id)!, mySecret),
      sender_pub: myPub,
    }));
  if (!rows.length) return 0;
  // Write-once rows: ignore conflicts so a concurrent sealer doesn't error us out.
  const { error } = await supabase
    .from("group_keys")
    .upsert(rows, { onConflict: "group_id,user_id,epoch", ignoreDuplicates: true });
  return error ? 0 : rows.length;
}

/** Open every epoch key addressed to me. */
function openMine(rows: KeyRow[], me: string, mySecret: Uint8Array): GroupKeys {
  const keys = new Map<number, Uint8Array>();
  rows
    .filter((r) => r.user_id === me)
    .forEach((r) => {
      const k = openGroupKey(r.sealed, r.sender_pub, mySecret);
      if (k) keys.set(r.epoch, k);
    });
  const epochs = [...keys.keys()];
  return { keys, current: epochs.length ? Math.max(...epochs) : null };
}

/**
 * Mint a group's first key and hand it to every member.
 * Returns false when the group has to stay plaintext (no identity unlocked).
 */
export async function provisionGroupKey(groupId: string, memberIds: string[]): Promise<boolean> {
  // Refused at the choke point rather than only at the call sites: keying Ping HQ
  // would lock out every member who joins it after this, and it is reachable from
  // any future caller that forgets the rule.
  if (groupId === PING_HQ) return false;
  const id = getIdentity();
  if (!id) return false;
  const n = await sealTo(groupId, newGroupKey(), 1, memberIds, id.sec, toB64(id.pub));
  return n > 0;
}

/**
 * Rotate to the next epoch because someone left. The insert into group_epochs is
 * the claim: its primary key means exactly one member wins the race, so two
 * people noticing the same departure cannot mint two different keys and split
 * the room. The loser just re-reads and adopts the winner's key.
 */
async function rotate(groupId: string, next: number, memberIds: string[], mySecret: Uint8Array, myPub: string, me: string) {
  const { error } = await supabase
    .from("group_epochs")
    .insert({ group_id: groupId, epoch: next, minted_by: me });
  if (error) return false; // someone else claimed this epoch
  await sealTo(groupId, newGroupKey(), next, memberIds, mySecret, myPub);
  return true;
}

/**
 * Load every key I hold for a group, and keep the group healthy while I'm here:
 * seal in members who were missing a key, and rotate when someone has left.
 * Old epochs are kept so old history stays readable.
 */
export async function loadGroupKeys(groupId: string, me: string, memberIds: string[]): Promise<GroupKeys> {
  const id = getIdentity();
  if (!id) return NONE;
  let rows = await rowsFor(groupId);
  let mine = openMine(rows, me, id.sec);
  if (mine.current === null) return NONE;

  const atCurrent = rows.filter((r) => r.epoch === mine.current);
  const departed = atCurrent.filter((r) => !memberIds.includes(r.user_id));

  if (departed.length && groupId !== PING_HQ) {
    if (await rotate(groupId, mine.current + 1, memberIds, id.sec, toB64(id.pub), me)) {
      rows = await rowsFor(groupId);
      mine = openMine(rows, me, id.sec);
    }
    // Lost the race: the winner's rows may not have landed yet. Next load picks
    // them up, and until then this member keeps sending on the old epoch.
  } else {
    // Nobody left, but someone may have joined — or been created without a
    // public key and since logged in. Seal them into the current epoch.
    const held = new Set(atCurrent.map((r) => r.user_id));
    const missing = memberIds.filter((m) => !held.has(m));
    const key = mine.keys.get(mine.current);
    if (missing.length && key) void sealTo(groupId, key, mine.current, missing, id.sec, toB64(id.pub));
  }
  return mine;
}

/**
 * The group's keys, minting a first one for a group that predates E2E if this
 * caller is allowed to. Only `created_by` backfills: two members minting at once
 * would each seal a different key and split the room, and a single writer is
 * cheaper than coordinating that. Old messages stay plaintext either way.
 */
export async function ensureGroupKeys(
  groupId: string,
  me: string,
  createdBy: string | null,
  memberIds: string[]
): Promise<GroupKeys> {
  const existing = await loadGroupKeys(groupId, me, memberIds);
  if (existing.current !== null || me !== createdBy) return existing;
  if (!(await provisionGroupKey(groupId, memberIds))) return NONE;
  return loadGroupKeys(groupId, me, memberIds);
}
