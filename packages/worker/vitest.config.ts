import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["src/**/*.test.ts"],
    poolOptions: {
      workers: {
        // NOTE: do not set miniflare.compatibilityDate here — the local
        // workerd build fails to start with an explicit date; the pool's
        // default works. wrangler.jsonc keeps the deploy-time date.
        miniflare: {
          compatibilityFlags: ["export_commonjs_default", "streams_enable_constructors"],
          // D1 binding for tests (migrations applied programmatically in
          // src/d1.test.ts).
          d1Databases: { DB: "test-db" },
        },
      },
    },
    // Resolve workspace packages to source so tests always exercise fresh code.
    alias: [
      {
        find: /^@lutragate\/core$/,
        replacement: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      },
      {
        find: /^@lutragate\/shared$/,
        replacement: fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      },
    ],
  },
});
