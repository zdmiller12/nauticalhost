import { describe, it, expect } from 'vitest';
import {
  buildQueue,
  DUPLICATE_IOU_THRESHOLD,
  findDuplicates,
  validatePosted,
  type QueueSource,
} from '../scripts/lib/dialog-session';
import type { BoundingBox } from '../src/lib/bounding-box';
import type { PhotoObjectEntry } from '../scripts/lib/photo-yaml';
import type { PhotoExif } from '../scripts/lib/exif';

const exif = (latitude: number | null, longitude: number | null): PhotoExif => ({
  camera: null,
  date: null,
  latitude,
  lens: null,
  longitude,
  other: {},
  utcOffsetMinutes: null,
});

const source = (overrides: Partial<QueueSource> = {}): QueueSource => ({
  exif: exif(44.1, -68.2),
  existingYaml: null,
  slug: 'DSC_0001',
  sourcePath: 'photos/DSC_0001.JPG',
  ...overrides,
});

describe('buildQueue', () => {
  it('carries slug, sourcePath and EXIF coordinates through', () => {
    expect(buildQueue([source()])).toEqual([
      {
        existingObjects: [],
        index: 0,
        latitude: 44.1,
        longitude: -68.2,
        objects: [],
        slug: 'DSC_0001',
        sourcePath: 'photos/DSC_0001.JPG',
      },
    ]);
  });

  it('prefers an explicit coordinate over EXIF GPS', () => {
    const [photo] = buildQueue([source({ latitude: 1.5, longitude: 2.5 })]);
    expect(photo.latitude).toBe(1.5);
    expect(photo.longitude).toBe(2.5);
  });

  it('falls back to EXIF GPS when no explicit coordinate is given', () => {
    const [photo] = buildQueue([source()]);
    expect(photo.latitude).toBe(44.1);
    expect(photo.longitude).toBe(-68.2);
  });

  it('carries pre-known objects through for the dialog to seed as drafts', () => {
    const objects: QueueSource['objects'] = [
      { boundingBox: null, description: null, objectType: 'organism', scientificName: 'Pandion haliaetus' },
    ];
    const [photo] = buildQueue([source({ objects })]);
    expect(photo.objects).toEqual(objects);
  });

  it('reports missing coordinates as null rather than omitting them', () => {
    const [photo] = buildQueue([source({ exif: exif(null, null) })]);
    expect(photo.latitude).toBeNull();
    expect(photo.longitude).toBeNull();
  });

  it('includes the objects already in an existing YAML', () => {
    const existingYaml = [
      'objects:',
      '  - boundingBox:',
      '      bottom: 0.8',
      '      left: 0.1',
      '      right: 0.4',
      '      top: 0.2',
      '    details:',
      '      commonName: "Herring Gull"',
      '      description: null',
      '      inaturalistObservationId: 7',
      '      scientificName: "Larus argentatus"',
      '    objectType: organism',
      '',
    ].join('\n');
    const [photo] = buildQueue([source({ existingYaml })]);
    expect(photo.existingObjects).toHaveLength(1);
    expect(photo.existingObjects[0].objectType).toBe('organism');
  });

  it('assigns each photo its position as a stable index', () => {
    const queue = buildQueue([source({ slug: 'a' }), source({ slug: 'b' })]);
    expect(queue.map((photo) => photo.index)).toEqual([0, 1]);
  });
});

const gull = (box: BoundingBox | null): PhotoObjectEntry => ({
  boundingBox: box,
  description: null,
  details: {
    commonName: 'Herring Gull',
    inaturalistObservationId: 7,
    scientificName: 'Larus argentatus',
  },
  objectType: 'organism',
});

describe('findDuplicates', () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ bottom, left, right, top });

  it('flags an organism with the same scientific name', () => {
    const warnings = findDuplicates([gull(box(0.1, 0.1, 0.4, 0.4))], {
      boundingBox: box(0.7, 0.7, 0.9, 0.9),
      description: null,
      objectType: 'organism',
      scientificName: 'Larus argentatus',
    });
    expect(warnings).toEqual([{ existingIndex: 0, reason: 'details' }]);
  });

  it('is case- and whitespace-insensitive about the scientific name', () => {
    const warnings = findDuplicates([gull(null)], {
      boundingBox: null,
      description: null,
      objectType: 'organism',
      scientificName: '  larus ARGENTATUS ',
    });
    expect(warnings).toEqual([{ existingIndex: 0, reason: 'details' }]);
  });

  it('flags a box that heavily overlaps an existing one, even for a different species', () => {
    const warnings = findDuplicates([gull(box(0.1, 0.1, 0.5, 0.5))], {
      boundingBox: box(0.11, 0.11, 0.51, 0.51),
      description: null,
      objectType: 'organism',
      scientificName: 'Haematopus palliatus',
    });
    expect(warnings).toEqual([{ existingIndex: 0, reason: 'overlap' }]);
  });

  it('does not flag a modest overlap', () => {
    expect(
      findDuplicates([gull(box(0, 0, 0.3, 0.3))], {
        boundingBox: box(0.2, 0.2, 0.6, 0.6),
        description: null,
        objectType: 'organism',
        scientificName: 'Haematopus palliatus',
      })
    ).toEqual([]);
  });

  it('reports details rather than overlap when both match', () => {
    const warnings = findDuplicates([gull(box(0.1, 0.1, 0.5, 0.5))], {
      boundingBox: box(0.1, 0.1, 0.5, 0.5),
      description: null,
      objectType: 'organism',
      scientificName: 'Larus argentatus',
    });
    expect(warnings).toEqual([{ existingIndex: 0, reason: 'details' }]);
  });

  it('flags a landmark with the same description', () => {
    const existing: PhotoObjectEntry = {
      boundingBox: null,
      description: 'Bass Harbor Head Light',
      objectType: 'landmark',
    };
    expect(
      findDuplicates([existing], {
        boundingBox: null,
        description: 'bass harbor head light',
        objectType: 'landmark',
      })
    ).toEqual([{ existingIndex: 0, reason: 'details' }]);
  });

  it('never flags across object types', () => {
    expect(
      findDuplicates([gull(null)], {
        boundingBox: null,
        description: 'Larus argentatus',
        objectType: 'landmark',
      })
    ).toEqual([]);
  });

  it('flags every existing object that matches', () => {
    const warnings = findDuplicates([gull(null), gull(null)], {
      boundingBox: null,
      description: null,
      objectType: 'organism',
      scientificName: 'Larus argentatus',
    });
    expect(warnings).toEqual([
      { existingIndex: 0, reason: 'details' },
      { existingIndex: 1, reason: 'details' },
    ]);
  });

  it('cannot compare boxes when either side has none', () => {
    expect(
      findDuplicates([gull(null)], {
        boundingBox: box(0.1, 0.1, 0.5, 0.5),
        description: null,
        objectType: 'organism',
        scientificName: 'Haematopus palliatus',
      })
    ).toEqual([]);
  });

  it('exposes its overlap threshold', () => {
    expect(DUPLICATE_IOU_THRESHOLD).toBeGreaterThan(0.5);
    expect(DUPLICATE_IOU_THRESHOLD).toBeLessThan(1);
  });
});

const queue = () => buildQueue([source()]);

const payload = (objects: unknown[], extra: Record<string, unknown> = {}) => ({
  photos: [{ index: 0, latitude: 44.1, longitude: -68.2, objects, ...extra }],
});

const organism = (overrides: Record<string, unknown> = {}) => ({
  boundingBox: { bottom: 0.5, left: 0.1, right: 0.4, top: 0.2 },
  description: null,
  objectType: 'organism',
  scientificName: 'Larus argentatus',
  ...overrides,
});

describe('validatePosted', () => {
  it('accepts a well-formed organism', () => {
    const outcome = validatePosted(payload([organism()]), queue());
    expect(outcome).toEqual({
      photos: [
        {
          index: 0,
          latitude: 44.1,
          longitude: -68.2,
          objects: [
            {
              boundingBox: { bottom: 0.5, left: 0.1, right: 0.4, top: 0.2 },
              description: null,
              objectType: 'organism',
              scientificName: 'Larus argentatus',
            },
          ],
          slug: 'DSC_0001',
          sourcePath: 'photos/DSC_0001.JPG',
        },
      ],
    });
  });

  it('accepts an object with no box', () => {
    const outcome = validatePosted(payload([organism({ boundingBox: null })]), queue());
    expect('photos' in outcome && outcome.photos[0].objects[0].boundingBox).toBeNull();
  });

  it('accepts a photo with no objects at all', () => {
    const outcome = validatePosted(payload([]), queue());
    expect('photos' in outcome && outcome.photos[0].objects).toEqual([]);
  });

  it('accepts an organism with a description', () => {
    const outcome = validatePosted(payload([organism({ description: 'A gull on the rocks' })]), queue());
    expect('photos' in outcome && outcome.photos[0].objects[0]).toMatchObject({
      description: 'A gull on the rocks',
    });
  });

  it('treats a non-string organism description as absent', () => {
    const outcome = validatePosted(payload([organism({ description: 42 })]), queue());
    expect('photos' in outcome && outcome.photos[0].objects[0]).toMatchObject({ description: null });
  });

  it('treats a non-string organism scientific name as blank', () => {
    expect(validatePosted(payload([organism({ scientificName: 42 })]), queue())).toEqual({
      errors: ['DSC_0001 object 1: an organism needs a scientific name.'],
    });
  });

  it('treats a non-string landmark description as blank', () => {
    expect(
      validatePosted(payload([{ boundingBox: null, description: 42, objectType: 'landmark' }]), queue())
    ).toEqual({ errors: ['DSC_0001 object 1: a landmark needs a description.'] });
  });

  it('treats a missing objects array as empty', () => {
    const outcome = validatePosted({ photos: [{ index: 0, latitude: 44.1, longitude: -68.2 }] }, queue());
    expect('photos' in outcome && outcome.photos[0].objects).toEqual([]);
  });

  it('accepts a landmark', () => {
    const outcome = validatePosted(
      payload([{ boundingBox: null, description: 'Bass Harbor Head Light', objectType: 'landmark' }]),
      queue()
    );
    expect('photos' in outcome && outcome.photos[0].objects[0].objectType).toBe('landmark');
  });

  it('rejects a payload that is not an object', () => {
    expect(validatePosted(null, queue())).toEqual({ errors: ['Expected a payload with a "photos" array.'] });
  });

  it('rejects a payload with no photos array', () => {
    expect(validatePosted({}, queue())).toEqual({ errors: ['Expected a payload with a "photos" array.'] });
  });

  it('rejects a photos entry that is not an object', () => {
    expect(validatePosted({ photos: [null] }, queue())).toEqual({
      errors: ['Expected each entry of "photos" to be an object.'],
    });
  });

  it('rejects an index that is not in the queue', () => {
    expect(validatePosted({ photos: [{ index: 9, objects: [] }] }, queue())).toEqual({
      errors: ['Photo 9 is not in this dialog session.'],
    });
  });

  it('rejects an unknown object type', () => {
    expect(validatePosted(payload([organism({ objectType: 'vehicle' })]), queue())).toEqual({
      errors: ['DSC_0001 object 1: objectType must be "organism" or "landmark".'],
    });
  });

  it('rejects an organism with a blank scientific name', () => {
    expect(validatePosted(payload([organism({ scientificName: '   ' })]), queue())).toEqual({
      errors: ['DSC_0001 object 1: an organism needs a scientific name.'],
    });
  });

  it('rejects a landmark with a blank description', () => {
    expect(
      validatePosted(payload([{ boundingBox: null, description: '', objectType: 'landmark' }]), queue())
    ).toEqual({ errors: ['DSC_0001 object 1: a landmark needs a description.'] });
  });

  it('rejects an object that is not an object', () => {
    expect(validatePosted(payload([null]), queue())).toEqual({
      errors: ['DSC_0001 object 1: expected an object.'],
    });
  });

  it('rejects a box that is not an object or null', () => {
    expect(validatePosted(payload([organism({ boundingBox: 'nope' })]), queue())).toEqual({
      errors: ['DSC_0001 object 1: box must be an object or null.'],
    });
  });

  it('rejects a box with a non-numeric edge', () => {
    expect(
      validatePosted(payload([organism({ boundingBox: { bottom: 0.5, left: 'x', right: 0.4, top: 0.2 } })]), queue())
    ).toEqual({ errors: ['DSC_0001 object 1: box edges must be numbers.'] });
  });

  it('rejects a box outside 0..1', () => {
    expect(
      validatePosted(payload([organism({ boundingBox: { bottom: 1.5, left: 0.1, right: 0.4, top: 0.2 } })]), queue())
    ).toEqual({ errors: ['DSC_0001 object 1: box edges are fractions and must be within 0..1.'] });
  });

  it('rejects a transposed or zero-area box', () => {
    expect(
      validatePosted(payload([organism({ boundingBox: { bottom: 0.2, left: 0.4, right: 0.1, top: 0.5 } })]), queue())
    ).toEqual({ errors: ['DSC_0001 object 1: box must have positive area (left<right, top<bottom).'] });
  });

  it('rejects coordinates that are not both present', () => {
    expect(validatePosted(payload([organism()], { longitude: null }), queue())).toEqual({
      errors: ['DSC_0001: latitude and longitude must both be set or both be blank.'],
    });
  });

  it('rejects non-numeric coordinates', () => {
    expect(validatePosted(payload([organism()], { latitude: 'north' }), queue())).toEqual({
      errors: ['DSC_0001: latitude and longitude must be numbers.'],
    });
  });

  it('accepts both coordinates blank', () => {
    const outcome = validatePosted(payload([organism()], { latitude: null, longitude: null }), queue());
    expect('photos' in outcome && outcome.photos[0].latitude).toBeNull();
  });

  // Clearing a prefilled EXIF coordinate by select-all-and-retype easily
  // leaves a space behind, and `Number(' ')` is 0 -- an observation at 0,0.
  it('treats a whitespace-only coordinate pair as blank', () => {
    const outcome = validatePosted(payload([organism()], { latitude: ' ', longitude: ' ' }), queue());
    expect('photos' in outcome && outcome.photos[0].latitude).toBeNull();
    expect('photos' in outcome && outcome.photos[0].longitude).toBeNull();
  });

  it('rejects a whitespace-only coordinate paired with a real number', () => {
    expect(validatePosted(payload([organism()], { latitude: ' ' }), queue())).toEqual({
      errors: ['DSC_0001: latitude and longitude must both be set or both be blank.'],
    });
  });

  it('collects every error rather than stopping at the first', () => {
    const outcome = validatePosted(
      payload([organism({ scientificName: '' }), organism({ objectType: 'vehicle' })]),
      queue()
    );
    expect('errors' in outcome && outcome.errors).toHaveLength(2);
  });

  it('reports duplicates instead of accepting, unless forced', () => {
    const sources: QueueSource[] = [
      source({
        existingYaml: [
          'objects:',
          '  - boundingBox: null',
          '    details:',
          '      commonName: "Herring Gull"',
          '      description: null',
          '      inaturalistObservationId: 7',
          '      scientificName: "Larus argentatus"',
          '    objectType: organism',
          '',
        ].join('\n'),
      }),
    ];
    const built = buildQueue(sources);
    expect(validatePosted(payload([organism()]), built)).toEqual({
      duplicates: [{ candidateIndex: 0, existingIndex: 0, photoIndex: 0, reason: 'details' }],
    });
    const forced = validatePosted(payload([organism()], { force: true }), built);
    expect('photos' in forced).toBe(true);
  });

  it('reports errors in preference to duplicates', () => {
    // "add anyway" answers "is this the same bird", not "is this box inside
    // the image" -- so a payload that is both duplicated and malformed must
    // surface the parse error rather than the duplicate warning.
    const sources: QueueSource[] = [
      source({
        existingYaml: [
          'objects:',
          '  - boundingBox: null',
          '    details:',
          '      commonName: "Herring Gull"',
          '      description: null',
          '      inaturalistObservationId: 7',
          '      scientificName: "Larus argentatus"',
          '    objectType: organism',
          '',
        ].join('\n'),
      }),
    ];
    const built = buildQueue(sources);
    const outcome = validatePosted(
      payload([organism(), organism({ boundingBox: { bottom: 0.2, left: 0.4, right: 0.1, top: 0.5 } })]),
      built
    );
    expect('errors' in outcome).toBe(true);
    expect('duplicates' in outcome).toBe(false);
  });
});
