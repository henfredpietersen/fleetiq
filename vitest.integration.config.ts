import path from "node:path";
import { defineConfig } from "vitest/config";

// Integration tests run against LOCAL Supabase only (synthetic data): `supabase start`, then
//   eval "$(supabase status -o env | sed 's/^/export /')" && npm run test:int
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "server-only": path.resolve(__dirname, "src/test/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.int.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
