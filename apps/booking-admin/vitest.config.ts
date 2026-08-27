import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL(".", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: [
      "app/**/*.test.ts",
      "services/**/*.test.ts",
      "lib/**/*.test.ts",
      "components/**/*.test.tsx",
    ],
  },
});
