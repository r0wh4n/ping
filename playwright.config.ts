import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PING_TEST_PORT ?? 3100);

// Chromium's own download is blocked in some environments, and the call tests
// only need a real Chrome — so drive the installed one rather than pinning a
// browser build. getUserMedia needs a secure context, hence the dev server:
// about:blank has no navigator.mediaDevices at all.
export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "chrome",
    permissions: ["microphone", "camera"],
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: {
    // Its own port: 3000 is often already taken by a dev server you are using,
    // and the tests must not depend on or disturb it.
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
