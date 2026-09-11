// Test-only stand-in for the `astro:content` virtual module, which only
// exists inside Astro's build/dev pipeline. Vitest runs content.config.ts
// as plain Node, so this alias (wired in vitest.config.ts) lets
// defineCollection() resolve without needing an Astro/Vite dev server.
export function defineCollection<T>(config: T): T {
  return config;
}
