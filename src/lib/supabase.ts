import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anon) {
  throw new Error(
    "Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local"
  );
}

// Single browser client. Uses Supabase Auth (username+password via a synthetic
// email) so the session persists per-device and follows the same credentials
// across devices.
export const supabase = createClient(url, anon, {
  realtime: { params: { eventsPerSecond: 20 } },
  auth: { persistSession: true, autoRefreshToken: true },
});
