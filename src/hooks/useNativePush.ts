"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Profile } from "@/hooks/useProfile";
import { nativePushSupported, pushPermission, saveNativeToken } from "@/lib/push";

// In the Android app: tapping a notification opens the chat it's about, and an
// install that already allows alerts refreshes its token on every launch, since
// FCM rotates them now and then. Does nothing in a browser.
export function useNativePush(profile: Profile | null) {
  const router = useRouter();

  useEffect(() => {
    if (!nativePushSupported()) return;
    let alive = true;
    let handle: { remove: () => Promise<void> } | undefined;
    import("@capacitor/push-notifications").then(async ({ PushNotifications }) => {
      const h = await PushNotifications.addListener("pushNotificationActionPerformed", ({ notification }) => {
        const url = notification.data?.url;
        if (typeof url === "string" && url.startsWith("/")) router.push(url);
      });
      if (alive) handle = h;
      else h.remove();
    });
    return () => {
      alive = false;
      handle?.remove();
    };
  }, [router]);

  useEffect(() => {
    if (!profile?.id || !nativePushSupported()) return;
    pushPermission().then((p) => {
      if (p === "granted") saveNativeToken(profile.id);
    });
  }, [profile?.id]);
}
