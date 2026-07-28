import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    headless: true,
    launchOptions: {
      // Software GL so headless Chromium can WebGL on a GPU-less CI runner.
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    },
  },
  projects: [
    {
      name: "smoke",
      testMatch: /smoke\.spec\.ts/,
      use: { browserName: "chromium" },
    },
    {
      name: "terrain",
      testMatch: /terrain\.spec\.ts/,
      use: { browserName: "chromium" },
    },
    {
      name: "golden",
      testMatch: /golden\.spec\.ts/,
      use: { browserName: "chromium" },
    },
    {
      name: "chromium",
      testIgnore: [/smoke\.spec\.ts/, /terrain\.spec\.ts/, /golden\.spec\.ts/],
      use: { browserName: "chromium" },
    },
  ],
});
