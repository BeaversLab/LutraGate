declare module "*?raw" {
  const content: string;
  export default content;
}

declare module "cloudflare:test" {
  // D1 binding configured in vitest.config.ts (miniflare d1Databases).
  interface ProvidedEnv {
    DB: D1Database;
  }
}
