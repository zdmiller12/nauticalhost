import { describe, it, expect } from 'vitest';

// These three files are thin CLI entry points: `import.meta.url === file://${process.argv[1]}`
// gates the actual bootstrap body (already /* v8 ignore */d), which only runs when the file
// is executed directly -- never true under vitest. Importing them here covers the top-level
// imports and the gate itself, which vitest's own collection run never touches otherwise.
describe('CLI entry scripts', () => {
  it('imports publish-photo.ts without running its bootstrap', async () => {
    await expect(import('../scripts/publish-photo')).resolves.toBeDefined();
  });

  it('imports publish-photo-csv.ts without running its bootstrap', async () => {
    await expect(import('../scripts/publish-photo-csv')).resolves.toBeDefined();
  });

  it('imports sync-inaturalist.ts without running its bootstrap', async () => {
    await expect(import('../scripts/sync-inaturalist')).resolves.toBeDefined();
  });
});
