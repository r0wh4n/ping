"use client";

import { useProfile } from "@/hooks/useProfile";
import { useNotifications } from "@/hooks/useNotifications";
import { usePresence } from "@/hooks/usePresence";

// Client layout wrapping /app and /app/dm/* — keeps the notification listener
// and online-presence tracking alive as the user moves between the friends
// list and chat threads (so a friend in a DM still shows as online).
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = useProfile();
  useNotifications(profile);
  usePresence(profile?.id ?? null);
  return <>{children}</>;
}
