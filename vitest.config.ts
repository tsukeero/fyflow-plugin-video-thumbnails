import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A Task runs the real service: spawning it and decoding a video take longer than vitest's default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
