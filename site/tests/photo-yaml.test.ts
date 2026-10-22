import { describe, it, expect } from 'vitest';
import {
  appendObjects,
  parsePhotoObjects,
  renderObject,
  renderObjectsBlock,
  type PhotoObjectEntry,
} from '../scripts/lib/photo-yaml';

const organism: PhotoObjectEntry = {
  boundingBox: { bottom: 0.75, left: 0.25, right: 0.6, top: 0.4 },
  details: {
    commonName: 'Osprey',
    description: null,
    inaturalistObservationId: 12345,
    scientificName: 'Pandion haliaetus',
  },
  objectType: 'organism',
};

const landmark: PhotoObjectEntry = {
  boundingBox: null,
  details: { description: 'Portland Head Light' },
  objectType: 'landmark',
};

const publishedYaml = `---
camera: "Canon: Canon EOS R7"
datetime: 2025-10-01T15:22:00Z
file: compendium/alpha/5G7A0094.JPG
latitude: 36.106871
lens: "RF70-200mm F2.8 L IS USM"
longitude: -82.102822
notes: # optional
objects:
  - boundingBox: null
    details:
      commonName: "Common Buckeye"
      description: null
      inaturalistObservationId: null
      scientificName: "Junonia coenia"
    objectType: organism
other:
  ISO: 100
  XResolution: 72
slug: 5G7A0094
tier: E
`;

describe('renderObject', () => {
  it('renders an organism with a box', () => {
    expect(renderObject(organism)).toBe(`  - boundingBox:
      bottom: 0.75
      left: 0.25
      right: 0.6
      top: 0.4
    details:
      commonName: "Osprey"
      description: null
      inaturalistObservationId: 12345
      scientificName: "Pandion haliaetus"
    objectType: organism`);
  });

  it('renders a null box and a landmark', () => {
    expect(renderObject(landmark)).toBe(`  - boundingBox: null
    details:
      description: "Portland Head Light"
    objectType: landmark`);
  });

  it('quotes a description that is present', () => {
    expect(
      renderObject({ ...organism, details: { ...organism.details, description: 'Perched on a piling.' } })
    ).toContain('description: "Perched on a piling."');
  });

  it('renders an organism with null inaturalistObservationId', () => {
    expect(
      renderObject({
        boundingBox: null,
        details: {
          commonName: 'Osprey',
          description: null,
          inaturalistObservationId: null,
          scientificName: 'Pandion haliaetus',
        },
        objectType: 'organism',
      })
    ).toContain('inaturalistObservationId: null');
  });

  // Guards sync-inaturalist.ts:28. Its ORGANISM_BLOCK regex matches four
  // consecutive lines INSIDE `details`; if this rendering ever drifts, the
  // observation backfill silently stops matching anything.
  it('stays matchable by sync-inaturalist ORGANISM_BLOCK', () => {
    const ORGANISM_BLOCK =
      /commonName: "(?<commonName>[^"]*)"\n\s+description: [^\n]*\n\s+inaturalistObservationId: (?<id>null|\d+)\n\s+scientificName: "(?<scientificName>[^"]*)"/g;
    const matches = [...renderObject(organism).matchAll(ORGANISM_BLOCK)];
    expect(matches).toHaveLength(1);
    expect(matches[0].groups).toMatchObject({
      commonName: 'Osprey',
      id: '12345',
      scientificName: 'Pandion haliaetus',
    });
  });
});

describe('renderObjectsBlock', () => {
  it('renders a commented placeholder when there are no objects', () => {
    const block = renderObjectsBlock([]);
    expect(block.startsWith('objects:\n')).toBe(true);
    expect(block).toContain('# - boundingBox: null');
    expect(block).toContain('#   objectType: organism');
  });

  it('renders each entry under the objects key', () => {
    const block = renderObjectsBlock([organism, landmark]);
    expect(block.startsWith('objects:\n')).toBe(true);
    expect(block).toContain('scientificName: "Pandion haliaetus"');
    expect(block).toContain('description: "Portland Head Light"');
  });
});

describe('appendObjects', () => {
  it('inserts after the existing entries and preserves every other byte', () => {
    const updated = appendObjects(publishedYaml, [landmark]);

    expect(updated).toContain(`    objectType: organism
  - boundingBox: null
    details:
      description: "Portland Head Light"
    objectType: landmark
other:`);
    // Hand-edited values and the inline comment must survive untouched.
    expect(updated).toContain('notes: # optional');
    expect(updated).toContain('tier: E');
    expect(updated).toContain('  XResolution: 72');
    expect(updated).toContain('camera: "Canon: Canon EOS R7"');
  });

  it('returns the text unchanged for an empty entry list', () => {
    expect(appendObjects(publishedYaml, [])).toBe(publishedYaml);
  });

  it('replaces a commented-out placeholder block instead of appending to it', () => {
    const scaffolded = `---
notes: # optional
${renderObjectsBlock([])}
slug: x
tier: E
`;
    const updated = appendObjects(scaffolded, [organism]);

    expect(updated).not.toContain('# - boundingBox');
    expect(updated).toContain('      scientificName: "Pandion haliaetus"');
    expect(updated).toContain('slug: x');
  });

  it('handles an objects block that ends the file', () => {
    const trailing = `---
slug: x
objects:
  - boundingBox: null
    details:
      description: "A"
    objectType: landmark
`;
    const updated = appendObjects(trailing, [landmark]);

    expect(updated.trimEnd().endsWith('    objectType: landmark')).toBe(true);
    expect(parsePhotoObjects(updated)).toHaveLength(2);
  });

  it('throws when there is no objects block to append to', () => {
    expect(() => appendObjects('---\nslug: x\n', [landmark])).toThrow(/objects:/);
  });
});

describe('parsePhotoObjects', () => {
  it('reads existing objects including their boxes', () => {
    const parsed = parsePhotoObjects(appendObjects(publishedYaml, [organism]));

    expect(parsed).toHaveLength(2);
    expect(parsed[0].boundingBox).toBeNull();
    expect(parsed[1].boundingBox).toEqual({ bottom: 0.75, left: 0.25, right: 0.6, top: 0.4 });
    expect(parsed[1].objectType).toBe('organism');
  });

  it('returns an empty list when there are no objects', () => {
    expect(parsePhotoObjects('---\nslug: x\n')).toEqual([]);
    expect(parsePhotoObjects('')).toEqual([]);
  });
});
