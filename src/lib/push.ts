import { supabase } from "@/lib/supabase";

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
const TOKEN_KEY = "ping.pushToken";

// The app shells inject window.Capacitor before the page runs, so these checks
// are synchronous and a browser never loads any Capacitor code.
type Cap = { isNativePlatform(): boolean; getPlatform(): string; isPluginAvailable(name: string): boolean };
const cap = (): Cap | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { Capacitor?: Cap }).Capacitor;

/** Inside the iOS or Android app rather than a browser. */
export function inNativeApp(): boolean {
  return !!cap()?.isNativePlatform();
}

/** The Android app build that carries the push plugin. iOS joins once APNs is set up. */
export function nativePushSupported(): boolean {
  const c = cap();
  return !!c?.isNativePlatform() && c.getPlatform() === "android" && c.isPluginAvailable("PushNotifications");
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported(): boolean {
  if (nativePushSupported()) return true;
  if (inNativeApp()) return false; // app shells have no web push
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Whether alerts are on, off or blocked, in a browser or the Android app. */
export async function pushPermission(): Promise<"granted" | "denied" | "prompt"> {
  if (nativePushSupported()) {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    const { receive } = await PushNotifications.checkPermissions();
    return receive === "granted" ? "granted" : receive === "denied" ? "denied" : "prompt";
  }
  if (typeof Notification === "undefined") return "denied";
  return Notification.permission === "default" ? "prompt" : Notification.permission;
}

// Asks Firebase for this install's token. Rejects if the device can't register.
async function registerNative(): Promise<string> {
  const { PushNotifications } = await import("@capacitor/push-notifications");
  // Heads-up banners need a high-importance channel; every FCM message names it.
  await PushNotifications.createChannel({ id: "messages", name: "Messages", importance: 4 }).catch(() => {});
  return new Promise<string>((resolve, reject) => {
    const handles: Promise<{ remove: () => Promise<void> }>[] = [];
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      handles.forEach((h) => h.then((x) => x.remove()));
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Timed out registering for alerts."))), 15000);
    handles.push(PushNotifications.addListener("registration", (t) => finish(() => resolve(t.value))));
    handles.push(PushNotifications.addListener("registrationError", (e) => finish(() => reject(new Error(e.error)))));
    PushNotifications.register().catch((e) => finish(() => reject(e)));
  });
}

// Stores this install's token for the signed-in person. Also run on each launch,
// since FCM rotates tokens now and then.
// ponytail: a token another account still holds (a shared phone that never
// signed out) fails the upsert under RLS; sign-out deletes the row, so that
// stays rare. A security-definer claim function fixes it if it ever matters.
export async function saveNativeToken(userId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const token = await registerNative();
    const { error } = await supabase
      .from("device_tokens")
      .upsert({ token, user_id: userId, platform: "android", last_seen: new Date().toISOString() }, { onConflict: "token" });
    if (error) return { ok: false, error: error.message };
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* the row is what matters */
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't register for alerts." };
  }
}

// Requests permission, registers the service worker, subscribes to push, and
// stores the subscription for the current user. Idempotent. In the Android app
// it asks for the notification permission and stores an FCM token instead.
export async function enablePush(userId: string): Promise<{ ok: boolean; error?: string }> {
  if (nativePushSupported()) {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    let { receive } = await PushNotifications.checkPermissions();
    if (receive !== "granted" && receive !== "denied") receive = (await PushNotifications.requestPermissions()).receive;
    if (receive !== "granted") return { ok: false, error: "denied" };
    return saveNativeToken(userId);
  }
  if (!pushSupported()) return { ok: false, error: "unsupported" };
  if (!VAPID_PUBLIC) return { ok: false, error: "Push isn't configured on the server." };

  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, error: "denied" };

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) as BufferSource,
    });
  }

  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) {
    return { ok: false, error: "Could not read the push subscription." };
  }

  const { error } = await supabase.from("push_subscriptions").upsert(
    { user_id: userId, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth },
    { onConflict: "endpoint" }
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// Signing out ends notifications on this device too, or a shared phone keeps
// showing the last person's messages. Removes the stored subscription while
// the session can still do so, then unsubscribes the browser. Best effort: a
// browser that refuses never blocks signing out.
export async function disablePush(): Promise<void> {
  if (nativePushSupported()) {
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) await supabase.from("device_tokens").delete().eq("token", token);
      localStorage.removeItem(TOKEN_KEY);
      const { PushNotifications } = await import("@capacitor/push-notifications");
      await PushNotifications.unregister();
    } catch {
      /* sign out regardless */
    }
    return;
  }
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  } catch {
    /* sign out regardless */
  }
}
