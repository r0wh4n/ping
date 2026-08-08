"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { normalizeUsername, validateUsername } from "@/lib/username";
import {
  deriveKey,
  openSecret,
  sealSecret,
  newKeyPair,
  newSaltB64,
  pubFromSecret,
  cacheIdentity,
  loadCachedIdentity,
  clearIdentity,
  toB64,
} from "@/lib/crypto";
import { solvePow } from "@/lib/pow";

export type Profile = { id: string; username: string };

type Result = { ok: boolean; error?: string };

// Usernames are the login identity; we map them to an internal email address
// that the user never sees or receives mail at (email confirmation is off).
// It only has to be unique + pass validation, so we use a real resolvable
// domain and turn underscores into hyphens (valid in the local part).
const emailFor = (username: string) => `${username.replace(/_/g, "-")}@theping.chat`;

export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);

  const loadProfile = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from("profiles")
      .select("id,username")
      .eq("id", userId)
      .maybeSingle();
    if (data) setProfile({ id: String(data.id), username: String(data.username) });
    // Session restore (no password available) → recover the E2E identity from cache.
    loadCachedIdentity(userId);
  }, []);

  // Unlock the E2E identity with the password (only available at login/signup).
  // Recovers the stored keypair, or provisions one on first use.
  const setupKeys = useCallback(async (userId: string, password: string) => {
    const { data: uk } = await supabase
      .from("user_keys")
      .select("encrypted_private_key,key_salt")
      .eq("user_id", userId)
      .maybeSingle();
    if (uk?.encrypted_private_key && uk?.key_salt) {
      const symKey = await deriveKey(password, String(uk.key_salt));
      const sec = openSecret(String(uk.encrypted_private_key), symKey);
      if (sec) {
        cacheIdentity(userId, { pub: pubFromSecret(sec), sec });
        return;
      }
      // Decrypt failed → the password changed; provision a fresh identity
      // (old messages become unreadable — the documented trade-off).
    }
    const id = newKeyPair();
    const salt = newSaltB64();
    const symKey = await deriveKey(password, salt);
    const enc = sealSecret(id.sec, symKey);
    await supabase
      .from("user_keys")
      .upsert({ user_id: userId, encrypted_private_key: enc, key_salt: salt }, { onConflict: "user_id" });
    await supabase.from("profiles").update({ public_key: toB64(id.pub) }).eq("id", userId);
    cacheIdentity(userId, id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session?.user) await loadProfile(session.user.id);
      if (!cancelled) setReady(true);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) loadProfile(session.user.id);
      else setProfile(null);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signUp = useCallback(
    async (username: string, password: string): Promise<Result> => {
      const uErr = validateUsername(username);
      if (uErr) return { ok: false, error: uErr };
      if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };
      const uname = normalizeUsername(username);

      // Solve the invisible proof-of-work gate (bot deterrent, no third party).
      const { bucket: powBucket, nonce: powNonce } = solvePow(uname);
      const body = { username: uname, password, powBucket, powNonce };

      // Create a pre-confirmed account server-side (no email sent, no rate limit).
      // Retry once to absorb edge-function cold starts.
      let res = await supabase.functions.invoke("account-signup", { body });
      if (res.error) {
        await new Promise((r) => setTimeout(r, 1200));
        res = await supabase.functions.invoke("account-signup", { body });
      }
      const { data, error } = res;
      if (error) return { ok: false, error: "Couldn't reach the server. Please try again." };
      if (!data?.ok) return { ok: false, error: data?.error ?? "Could not create account." };

      // Establish the session (password sign-in — no email involved).
      const { data: li, error: liErr } = await supabase.auth.signInWithPassword({
        email: emailFor(uname),
        password,
      });
      if (liErr || !li.user) return { ok: false, error: "Account created — please log in." };
      await setupKeys(li.user.id, password);
      await loadProfile(li.user.id);
      return { ok: true };
    },
    [loadProfile, setupKeys]
  );

  const logIn = useCallback(
    async (username: string, password: string): Promise<Result> => {
      const uname = normalizeUsername(username);
      if (!uname) return { ok: false, error: "Enter your handle." };
      const { data, error } = await supabase.auth.signInWithPassword({
        email: emailFor(uname),
        password,
      });
      if (error) return { ok: false, error: "Wrong handle or password." };
      if (data.user) {
        await setupKeys(data.user.id, password);
        await loadProfile(data.user.id);
      }
      return { ok: true };
    },
    [loadProfile, setupKeys]
  );

  const signOut = useCallback(async () => {
    clearIdentity(profile?.id);
    await supabase.auth.signOut();
    setProfile(null);
  }, [profile?.id]);

  // Permanently delete the account. The edge function deletes the auth user,
  // which cascades to the profile and all friendships/messages/subscriptions.
  const deleteAccount = useCallback(async (): Promise<Result> => {
    const res = await supabase.functions.invoke("account-delete", { body: {} });
    if (res.error) return { ok: false, error: "Couldn't reach the server. Please try again." };
    if (!res.data?.ok) return { ok: false, error: res.data?.error ?? "Could not delete account." };
    await supabase.auth.signOut();
    setProfile(null);
    return { ok: true };
  }, []);

  return { profile, ready, signUp, logIn, signOut, deleteAccount };
}
