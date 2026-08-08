"use client";

import { useEffect } from "react";
import type { Profile } from "@/hooks/useProfile";

/**
 * Ensures the service worker is registered for users who've already granted
 * notification permission, so web pushes are received on return visits.
 * The actual subscribe/permission flow lives in `enablePush` (lib/push).
 */
export function useNotifications(profile: Profile | null) {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* ignore */
    });
  }, [profile?.id]);
}
