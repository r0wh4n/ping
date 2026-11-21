import type { CapacitorConfig } from "@capacitor/cli";

// The iOS and Android apps are native shells around the live site: they open
// theping.chat/app, so every web deploy reaches them without a store update.
// ponytail: remote site, not a bundled build. The site has server routes (mcp,
// a2a, hook) that a static export can't carry; bundle only if review demands it.
const config: CapacitorConfig = {
  appId: "chat.theping.app",
  appName: "Ping",
  webDir: "mobile", // holds only the offline page
  backgroundColor: "#000000",
  server: {
    url: "https://theping.chat",
    // Leading slash matters: Android appends this to url as plain text
    // ("app" opened theping.chatapp); iOS joins path parts, so both work.
    appStartPath: "/app",
    errorPath: "offline.html",
  },
  // White status bar icons on Ping's black, whatever the phone's own theme.
  plugins: { SystemBars: { style: "DARK" } },
};

export default config;
