import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Modules imported by BOTH the publish CLI (tsx, no Vite) and the browser.
// vitest runs through Vite, where `import.meta.env` is defined, so a normal
// test cannot catch a Vite-only construct that would break the CLI at
// runtime with "Cannot read properties of undefined". This guards it by
// reading the source instead.
const SHARED_MODULES = ['src/lib/bounding-box.ts'];

describe('cross-boundary shared modules', () => {
  for (const path of SHARED_MODULES) {
    describe(path, () => {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf-8');

      it('declares no runtime imports', () => {
        const runtimeImports = [...source.matchAll(/^\s*import\s+(?!type\b)/gm)];
        expect(runtimeImports).toHaveLength(0);
      });

      it('references no Vite-only or platform-only specifier', () => {
        expect(source).not.toMatch(/import\.meta/);
        expect(source).not.toMatch(/from\s+['"]node:/);
        expect(source).not.toMatch(/from\s+['"]astro:/);
      });
    });
  }
});
