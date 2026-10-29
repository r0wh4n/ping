"use client";

import { useEffect, useState } from "react";
import { enablePush, pushSupported } from "@/lib/push";

// iPhones and iPads only expose PushManager once the site is on the Home Screen
// (iOS 16.4+). An open Safari tab gets nothing and there is no API to ask for —
// so the only useful thing to show there is how to install.
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac; touch points give it away.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

type State = "loading" | "off" | "on" | "busy" | "denied" | "install" | "unsupported";

// Turns phone alerts on for someone watching agent rooms. Rooms belong to agent
// tokens, not accounts, so the people notified are the room's owner and anyone
// who added it to Mission Control — this is how they get a subscription.
export default function PushSetup({ userId }: { userId: string }) {
  const [state, setState] = useState<State>("loading");
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    if (!pushSupported()) {
      setState(isIOS() ? "install" : "unsupported");
      return;
    }
    if (Notification.permission === "granted") setState("on");
    else if (Notification.permission === "denied") setState("denied");
    else setState("off");
  }, []);

  const enable = async () => {
    setState("busy");
    setErr(null);
    const res = await enablePush(userId);
    if (res.ok) setState("on");
    else if (res.error === "denied") setState("denied");
    else if (res.error === "unsupported") setState(isIOS() ? "install" : "unsupported");
    else {
      setState("off");
      setErr(res.error ?? "Couldn't turn on alerts.");
    }
  };

  if (state === "loading" || state === "unsupported") return null;

  const chip = "mono rounded-full border border-border px-2.5 py-1 text-[11px] transition";

  if (state === "install") {
    return (
      <div className="relative">
        <button onClick={() => setHint((h) => !h)} className={`${chip} text-muted hover:text-text`}>
          Alerts: add to Home Screen
        </button>
        {hint && (
          <div className="absolute right-0 top-full z-20 mt-2 w-64 rounded-lg border border-border bg-[color:var(--panel)] p-3 text-[11px] leading-relaxed text-muted shadow-lg">
            iOS only delivers push to installed sites. In Safari, tap Share, then{" "}
            <span className="text-text">Add to Home Screen</span>, and open Ping from the icon.
            Alerts can be turned on there.
          </div>
        )}
      </div>
    );
  }

  if (state === "on") return <span className={`${chip} text-muted`}>Alerts on</span>;
  if (state === "denied") {
    return <span className={`${chip} text-muted`} title="Re-allow notifications in your browser settings">Alerts blocked</span>;
  }

  return (
    <button onClick={enable} disabled={state === "busy"} className={`${chip} hover:border-[color:var(--border-strong)] disabled:opacity-40`}>
      {state === "busy" ? "…" : err ? "Retry alerts" : "Alert me"}
    </button>
  );
}
