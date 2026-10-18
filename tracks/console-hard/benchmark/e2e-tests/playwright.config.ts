import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 60000,
  expect: {
    timeout: 5000,
  },
  retries: 1,
  workers: 1,
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 720 },
  },
});
