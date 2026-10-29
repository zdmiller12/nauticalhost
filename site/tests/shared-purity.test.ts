import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Modules imported by BOTH the publish CLI (tsx, no Vite) and the browser.
// vitest runs through Vite, where `import.meta.env` is defined, so a normal
// test cannot catch a Vite-only construct that would break the CLI at
// runtime with "Cannot read properties of undefined". This guards it by
// reading the source instead.
//
// dialog-client.ts is here for a second reason: dialog-server.ts ships it
// through `esbuild.transform()`, which does NOT bundle, so a runtime import
// would reach the browser as an unresolvable bare specifier.
const SHARED_MODULES = ['scripts/lib/dialog-client.ts', 'src/lib/bounding-box.ts'];

/** Strip line and block comments from source code. */
function stripComments(source: string): string {
  // Remove block comments first: /* ... */
  let stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments: // ...
  stripped = stripped.replace(/\/\/.*$/gm, '');
  return stripped;
}

describe('cross-boundary shared modules', () => {
  for (const path of SHARED_MODULES) {
    describe(path, () => {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf-8');

      it('declares no runtime imports', () => {
        // Three forms, all of which reach the browser as a bare specifier:
        //   1. a static `import … from` that is not `import type`
        //   2. `export { x } from './y'` -- a re-export is a runtime import
        //   3. `import('./x')` -- dynamic, and has no whitespace after `import`
        // Do not "simplify" 2 and 3 away; neither anchors on a leading
        // `import` followed by whitespace, so the first alternative misses both.
        const runtimeImports = [
          ...source.matchAll(/^\s*import\s+(?!type\b)|^\s*export\s+(?!type\b)[^;\n]*\sfrom\b|\bimport\s*\(/gm),
        ];
        expect(runtimeImports).toHaveLength(0);
      });

      it('references no Vite-only or platform-only specifier', () => {
        const sourceWithoutComments = stripComments(source);
        expect(sourceWithoutComments).not.toMatch(/import\.meta/);
        expect(sourceWithoutComments).not.toMatch(/from\s+['"]node:/);
        expect(sourceWithoutComments).not.toMatch(/from\s+['"]astro:/);
      });
    });
  }
});
