import { defineConfig } from "@playwright/test";

// Smoke-test gate (see vault Firmware/BACKLOG.md "Harness" item): runs the
// app in browser-mock mode (no Tauri, hid.rs is never touched) against the
// Vite dev server and asserts the board actually renders. Not a full test
// suite - it exists to catch "the app doesn't boot" before merge.
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  webServer: {
    command: "npm run dev -- --port 5173",
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  use: {
    baseURL: "http://localhost:5173",
  },
});
