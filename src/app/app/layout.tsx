"use client";

import { useProfile } from "@/hooks/useProfile";
import { useNotifications } from "@/hooks/useNotifications";

// Client layout wrapping /app and /app/dm/* — keeps the notification listener
// alive as the user moves between the friends list and chat threads.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = useProfile();
  useNotifications(profile);
  return <>{children}</>;
}
