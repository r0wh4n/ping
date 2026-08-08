// Ping service worker — receives web pushes and shows notifications.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  event.waitUntil(
    (async () => {
      const clientsArr = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const focused = clientsArr.some((c) => c.focused && c.visibilityState === "visible");
      if (focused) return; // app is open and focused — no OS notification needed
      await self.registration.showNotification(data.title || "Ping", {
        body: data.body || "",
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: data.tag || "ping-msg",
        data: { url: data.url || "/app" },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/app";
  event.waitUntil(
    (async () => {
      const clientsArr = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clientsArr) {
        if ("focus" in c) {
          try {
            await c.navigate(url);
          } catch (e) {
            /* ignore */
          }
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })()
  );
});
