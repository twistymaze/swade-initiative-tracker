import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      coverage: {
        provider: "v8",
        include: ["src/**"],
        exclude: [
          "src/**/*.test.{ts,tsx}",
          "src/test/**",
          "src/components/testUtils.tsx",
          "src/main.tsx",
          "src/vite-env.d.ts",
          "src/**/*.css",
        ],
        reporter: [["text", { skipFull: false }]],
        thresholds: {
          "src/store/**": { lines: 90 },
          "src/utils/**": { lines: 95 },
        },
      },
    },
  })
);
