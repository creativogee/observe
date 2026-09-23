import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.int-spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
