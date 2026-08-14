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
      "components/**/*.test.tsx",
      "services/**/*.test.ts",
      "lib/**/*.test.ts",
    ],
  },
});
