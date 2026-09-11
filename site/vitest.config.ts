import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // content.config.ts imports the `astro:content` virtual module, which
      // only exists inside Astro's build/dev pipeline. Point it at a stub so
      // the file can be imported and tested as plain Node/Vitest.
      'astro:content': fileURLToPath(new URL('./tests/stubs/astro-content.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['scripts/**/*.ts', 'src/**/*.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        100: true,
        perFile: true,
      },
    },
  },
});
