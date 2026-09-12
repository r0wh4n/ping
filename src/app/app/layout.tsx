"use client";

import { useProfile } from "@/hooks/useProfile";
import { useNotifications } from "@/hooks/useNotifications";
import { usePresence } from "@/hooks/usePresence";
import { CallProvider } from "@/components/CallOverlay";

// Client layout wrapping /app and /app/dm/* — keeps the notification listener
// and online-presence tracking alive as the user moves between the friends
// list and chat threads (so a friend in a DM still shows as online).
// CallProvider lives here too so an incoming call rings anywhere in the app,
// not only inside the thread it was placed from.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = useProfile();
  useNotifications(profile);
  usePresence(profile?.id ?? null);
  return <CallProvider profile={profile}>{children}</CallProvider>;
}
